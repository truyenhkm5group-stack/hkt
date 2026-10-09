/**
 * ═══════════ VỎ CHỐT ĐƠN — THƯƠNG HIỆU SAU `redirect()` + CHỮ KỸ THUẬT CÒN SÓT (Commercial Polish Board C1 #6 · #7) ═══════════
 *
 * #6 — Khách Chốt Đơn đặt mật khẩu ở `/reset/…` ⇒ trang đăng nhập dựng thương hiệu VNX, tải lại mới đúng. Lượt dựng sau
 *      `redirect()` của server action là một `fetch` máy chủ tự gửi tới `localhost:<cổng>` (Node bỏ header Host). #700 đọc
 *      `x-forwarded-host`; bản này thêm lớp thứ hai không phụ thuộc proxy: action gắn `?brand=` (danh sách trắng) vào đích chuyển
 *      hướng, middleware đọc lại — và host đã nhận ra thương hiệu thì LUÔN thắng gợi ý.
 *
 * #7 — Chữ kỹ thuật (webhook · token · ERP · API · TEST · field · connector · module · Viettel · ORDER_OUTCOME) ở những trang
 *      người vỏ Chốt Đơn mở được. Quét MÃ NGUỒN bằng cây cú pháp TypeScript (không phải regex trên dòng): mọi chuỗi / chữ JSX
 *      chứa từ cấm phải nằm ở nhánh KHÔNG BAO GIỜ tới vỏ — vế `: …` của `shell ? … : …` (cùng họ: `customer`, `chotdon`, `plain`,
 *      `isSalesAgentUser(…)`), vế `? …` / `&& …` của điều kiện chỉ-ERP (`!shell`, `copy.isHome`, `operator`, `homeOnly`,
 *      `shellAllows(…)`), hoặc thân `if (!shell)`. Còn lại phải khai MIỄN TRỪ kèm lý do; miễn trừ không còn khớp gì ⇒ đỏ.
 *
 * Tên mục của BÊN THỨ BA đặt trong «…» (vd mục «Webhook» trong Pancake, «App ID» của Zalo) không tính: chủ shop phải tìm đúng
 * chữ ấy trên màn hình của họ, và câu quanh nó đã giải thích bằng tiếng Việt.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { BRAND_HINT_PARAM, brandHint, brandOfRequest, knownBrandOfHost, withBrandHint, type SiteEnv } from "@/lib/platform/site-host";

const goc = path.resolve(__dirname, "..");
const rel = (abs: string) => path.relative(goc, abs).split(path.sep).join("/");

// ─────────────────────────────── #6 · THƯƠNG HIỆU SAU redirect() ───────────────────────────────

function testBrandAfterRedirect() {
  const env: SiteEnv = { SITE_DOMAIN: "vnxcommerce.com", CHOTDON_DOMAIN: "chotdontudong.com", APP_URL: "https://erp.vnxcommerce.com" };
  const hdr = (h: Record<string, string>) => (name: string) => h[name] ?? null;
  const hintOf = (url: string) => new URL(url, "http://localhost:3000").searchParams.get(BRAND_HINT_PARAM);

  // Đích chuyển hướng: VNX giữ nguyên URL; Chốt Đơn thêm đúng một tham số, giữ query + neo; đích tuyệt đối / `//` không gắn.
  assert.equal(withBrandHint("/login?reason=password_changed", "vnx"), "/login?reason=password_changed");
  assert.equal(withBrandHint("/login?reason=password_changed", "chotdon"), "/login?reason=password_changed&brand=chotdon");
  assert.equal(withBrandHint("/login", "chotdon"), "/login?brand=chotdon");
  assert.equal(withBrandHint("/login?brand=vnx#x", "chotdon"), "/login?brand=chotdon#x", "không nhân đôi tham số, giữ neo");
  assert.equal(withBrandHint("https://evil.example/login", "chotdon"), "https://evil.example/login");
  assert.equal(withBrandHint("//evil.example/login", "chotdon"), "//evil.example/login");

  // LƯỢT DỰNG SAU redirect(): host là `localhost:<cổng>`, proxy không để lại `x-forwarded-host` ⇒ trước bản vá ra VNX.
  const target = withBrandHint("/login?reason=password_changed", "chotdon");
  assert.equal(brandOfRequest(hdr({ host: "localhost:3000" }), env), "vnx", "đối chứng: không gợi ý ⇒ VNX — đúng lỗi C1 #6");
  assert.equal(brandOfRequest(hdr({ host: "localhost:3000" }), env, hintOf(target)), "chotdon", "lượt sau redirect() đọc gợi ý ⇒ Chốt Đơn ngay lượt đầu");

  // HOST THẮNG: host đã nhận ra thương hiệu thì gợi ý bị bỏ qua — cả hai chiều.
  assert.equal(brandOfRequest(hdr({ host: "erp.vnxcommerce.com" }), env, "chotdon"), "vnx", "erp.vnxcommerce.com/login?brand=chotdon vẫn là VNX");
  assert.equal(brandOfRequest(hdr({ host: "localhost:3000", "x-forwarded-host": "erp.vnxcommerce.com" }), env, "chotdon"), "vnx", "x-forwarded-host đã biết thắng gợi ý");
  assert.equal(brandOfRequest(hdr({ host: "app.chotdontudong.com" }), env, "vnx"), "chotdon", "host Chốt Đơn không bị gợi ý kéo về VNX");
  assert.equal(brandOfRequest(hdr({ host: "shop-a.vnxcommerce.com" }), env, "chotdon"), "vnx", "tên miền con tổ chức là host VNX đã biết");
  assert.equal(brandOfRequest(hdr({ host: "vnxcommerce.com" }), env, "chotdon"), "vnx");

  // DANH SÁCH TRẮNG: chỉ hai giá trị; chữ hoa, khoảng trắng, thương hiệu lạ ⇒ như không có.
  for (const bad of ["CHOTDON", " chotdon", "evil", "", "chotdon,vnx"]) {
    assert.equal(brandHint(bad), null, `«${bad}» không phải thương hiệu`);
    assert.equal(brandOfRequest(hdr({ host: "localhost:3000" }), env, bad), "vnx");
  }
  assert.equal(knownBrandOfHost("localhost:3000", env), null, "host lạ không nói được gì");
  assert.equal(knownBrandOfHost("app.chotdontudong.com.evil.com", env), null, "đuôi giả mạo không thành thương hiệu");
  assert.equal(knownBrandOfHost("ERP.vnxcommerce.com:443", env), "vnx");

  // NỐI DÂY: mọi action chuyển về /login gắn thương hiệu của host thật; middleware chuyển gợi ý vào `brandOfRequest`.
  const src = (f: string) => readFileSync(path.join(goc, f), "utf8");
  assert.match(src("lib/actions/password-reset.ts"), /redirect\(withBrandHint\(`\/login\?reason=\$\{REASON_PASSWORD_CHANGED\}`, await hostBrand\(\)\)\)/, "đặt mật khẩu xong ⇒ /login mang thương hiệu");
  for (const f of ["lib/actions/password-reset.ts", "lib/actions/auth.ts", "lib/actions/session-revoke.ts", "lib/actions/onboarding.ts", "lib/actions/user-invites.ts"]) {
    const s = src(f);
    assert.ok(!/redirect\(\s*["`]\/login/.test(s) && !/:\s*"\/login"\)/.test(s), `${f}: chuyển về /login phải đi qua withBrandHint`);
  }
  assert.match(src("middleware.ts"), /brandOfRequest\(\(name\) => request\.headers\.get\(name\), siteEnvFromProcess\(\), request\.nextUrl\.searchParams\.get\(BRAND_HINT_PARAM\)\)/, "middleware đọc gợi ý khi đặt header thương hiệu");
}

// ─────────────────────────────── #7 · CHỮ KỸ THUẬT TRONG VỎ ───────────────────────────────

/** Từ cấm trong phần HIỂN THỊ cho người vỏ Chốt Đơn. */
const FORBIDDEN: readonly { word: string; re: RegExp }[] = [
  { word: "webhook", re: /\bwebhooks?\b/i },
  { word: "token", re: /\btokens?\b/i },
  { word: "ERP", re: /\bERP\b/ },
  { word: "API", re: /\bAPI\b/ },
  { word: "TEST", re: /\bTEST\b/ },
  { word: "field", re: /\bfields?\b/i },
  { word: "connector", re: /\bconnectors?\b/i },
  { word: "module", re: /\bmodules?\b/i },
  { word: "Viettel", re: /\bViettel\b/i },
  { word: "ORDER_OUTCOME", re: /\bORDER_OUTCOME\b/ },
];

/** Cây thư mục / tệp người vỏ mở được (SALES_AGENT_ALLOWED_PREFIXES + trang công khai của lời mời) — phạm vi R1 §5, R2 C3. */
const ROOTS = [
  "app/(dashboard)/ai",
  "app/(dashboard)/settings/connections",
  "app/(dashboard)/settings/profile",
  "app/(dashboard)/settings/notifications",
  "app/(dashboard)/settings/data-export",
  "app/(dashboard)/settings/plan",
  "app/(dashboard)/settings/shop",
  "app/(dashboard)/settings/branding",
  "app/(dashboard)/settings/ai-balance",
  "app/(dashboard)/setup",
  "app/join",
  "components/connectors/connector-group-table.tsx",
  "components/connectors/legacy-connections.tsx",
  "lib/onboarding/progress.ts",
];

/** Tệp nằm dưới ROOTS nhưng KHÔNG BAO GIỜ dựng cho người vỏ — kèm lý do. */
const NOT_IN_SHELL: Readonly<Record<string, string>> = {
  "app/(dashboard)/ai/sales-chatbot/cost-panel.tsx": "chỉ dựng khi `ai.audience === \"INTERNAL\"` (costReport) — khách không nhận chi phí AI (lib/saas/visibility.ts)",
  "app/(dashboard)/ai/sales-chatbot/page-runtime-panel.tsx": "chỉ workspace NHÀ (`pageRuntime?.isHome`)",
};

/** Chuỗi chứa từ cấm mà quét cú pháp không tự thấy là nhánh ERP — khai tay, có lý do. Miễn trừ không còn khớp ⇒ đỏ. */
const EXEMPT: readonly { file: string; needle: string; why: string }[] = [
  { file: "app/(dashboard)/ai/sales-chatbot/inbox/thread-view.tsx", needle: "Nhân viên / tự động (ngoài ERP)", why: "bảng nhãn của ERP; vỏ dùng SHELL_SIDE_LABEL — `layout(…, shell ? SHELL_SIDE_LABEL : SIDE_LABEL)`" },
  { file: "app/(dashboard)/ai/sales-chatbot/messenger/page.tsx", needle: "webhook", why: "tên tham số URL `?webhook=` (one(\"webhook\")), không in ra" },
  { file: "components/connectors/connector-group-table.tsx", needle: "Webhook", why: "nằm trong ⓘ chỉ dựng khi `row.why` — khách không nhận `why` (customerConnectionsView, lib/saas/visibility.ts)" },
  { file: "app/(dashboard)/settings/plan/page.tsx", needle: "Lượt · token · tiền ƯỚC TÍNH", why: "khung «Dùng AI» chỉ dựng dưới `ai ?` — khách: `ai = null`" },
];

/** Điều kiện mà vế ĐÚNG là nhánh vỏ ⇒ vế SAI chỉ tới người ERP. */
const SHELL_TRUE = /^(shell|customer|chotdon|plain|isSalesAgentUser\([^)]*\))$/;
/** Điều kiện mà vế ĐÚNG không bao giờ tới người vỏ. `report.withMoney` = `manage && !customerFacing(org)`. */
const ERP_TRUE = /^(!shell|!customer|!chotdon|!plain|copy\.isHome|operator|homeOnly|report\.withMoney|shellAllows\([^)]*\))$/;
/** Thuộc tính JSX không hiện chữ. */
const HIDDEN_ATTR = /^(className|key|id|htmlFor|href|src|type|rel|target|variant|size|role|name|method|data-[\w-]+)$/;

function filesUnder(root: string): string[] {
  const abs = path.join(goc, root);
  if (statSync(abs).isFile()) return [root];
  const out: string[] = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...filesUnder(rel(full)));
    else if (/\.tsx?$/.test(e.name)) out.push(rel(full));
  }
  return out;
}

/** Nút này nằm ở nhánh không bao giờ tới vỏ? */
function erpOnly(node: ts.Node, sf: ts.SourceFile): boolean {
  let child: ts.Node = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isConditionalExpression(p)) {
      const cond = p.condition.getText(sf).replace(/\s+/g, "");
      if (SHELL_TRUE.test(cond) && child === p.whenFalse) return true;
      if (ERP_TRUE.test(cond) && child === p.whenTrue) return true;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === p.right && ERP_TRUE.test(p.left.getText(sf).replace(/\s+/g, ""))) return true;
    if (ts.isIfStatement(p) && child === p.thenStatement && ERP_TRUE.test(p.expression.getText(sf).replace(/\s+/g, ""))) return true;
  }
  return false;
}

/** Chuỗi này có tới mắt người đọc không (không phải khoá, phép so sánh, thuộc tính ẩn, kiểu, import)? */
function visible(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return false;
  if (ts.isCaseClause(p)) return false;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return false;
  if (ts.isJsxAttribute(p) && HIDDEN_ATTR.test(p.name.getText())) return false;
  return true;
}

type Hit = { file: string; line: number; word: string; text: string };

function scanFile(file: string): Hit[] {
  const code = readFileSync(path.join(goc, file), "utf8");
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const check = (node: ts.Node, text: string) => {
    // Tên mục của bên thứ ba trong «…» được phép (xem đầu tệp).
    const plain = text.replace(/«[^»]*»/g, "«»");
    for (const f of FORBIDDEN) {
      if (!f.re.test(plain)) continue;
      if (!visible(node) || erpOnly(node, sf)) continue;
      hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, word: f.word, text: text.trim().slice(0, 140) });
    }
  };
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      check(node, node.head.text);
      for (const span of node.templateSpans) check(span.literal, span.literal.text);
    } else if (ts.isJsxText(node)) check(node, node.text);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return hits;
}

function testShellCopy() {
  const files = [...new Set(ROOTS.flatMap(filesUnder))].filter((f) => !(f in NOT_IN_SHELL)).sort();
  assert.ok(files.length > 30, `quét quá ít tệp (${files.length}) — đường dẫn ROOTS lệch mã`);
  for (const f of Object.keys(NOT_IN_SHELL)) assert.ok(ROOTS.flatMap(filesUnder).includes(f), `NOT_IN_SHELL khai tệp không còn tồn tại: ${f}`);

  const all = files.flatMap(scanFile);
  const used = new Set<number>();
  const left = all.filter((h) => {
    const i = EXEMPT.findIndex((e) => e.file === h.file && h.text.includes(e.needle.slice(0, 140)) || (e.file === h.file && e.needle === h.text));
    if (i >= 0) used.add(i);
    return i < 0;
  });
  assert.deepEqual(
    left.map((h) => `${h.file}:${h.line} «${h.word}» — ${h.text}`),
    [],
    "chữ kỹ thuật lộ ra ở nhánh người vỏ Chốt Đơn thấy — gác bằng `shell ? … : …` (hoặc khai EXEMPT kèm lý do)",
  );
  EXEMPT.forEach((e, i) => assert.ok(used.has(i), `miễn trừ không còn khớp gì — xoá đi: ${e.file} «${e.needle}»`));
  for (const e of EXEMPT) assert.ok(e.why.length > 20, `miễn trừ phải có lý do: ${e.file} «${e.needle}»`);

  // Đối chứng: bộ quét THẤY từ cấm ở nhánh vỏ (không phải xanh vì không đọc được gì).
  const probe = ts.createSourceFile("probe.tsx", 'const a = shell ? "Dán URL webhook" : "ok"; const b = <p>{shell ? "ổn" : "ERP"}</p>; const c = "token";', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const seen: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) && FORBIDDEN.some((f) => f.re.test(n.text)) && visible(n) && !erpOnly(n, probe)) seen.push(n.text);
    ts.forEachChild(n, walk);
  };
  walk(probe);
  assert.deepEqual(seen, ["Dán URL webhook", "token"], "bộ quét phải bắt vế vỏ và chuỗi không gác, bỏ qua vế ERP");

  // Những câu kiểm toán R1 §5 / R2 C3 đã nêu tên: bản vỏ có mặt (khoá đúng chỗ đã sửa, không chỉ «không còn từ cấm»).
  const src = (f: string) => readFileSync(path.join(goc, f), "utf8");
  assert.ok(src("app/(dashboard)/settings/profile/page.tsx").includes('shell ? "Cài ứng dụng lên màn hình chính'), "Tài khoản: «Cài ERP lên màn hình chính» có bản vỏ");
  assert.ok(src("app/(dashboard)/settings/connections/page.tsx").includes("rows: g.rows.filter((r) => r.moduleEnabled)"), "Kết nối: vỏ chỉ hiện kết nối thuộc gói (không Viettel Post / GHN / GHTK)");
  assert.ok(/if \(!shell\) steps\.push\(\{\s*key: "pages"/.test(src("lib/onboarding/progress.ts")), "Thiết lập: không bước nào dẫn tới /p/… ở vỏ");
  assert.ok(src("app/(dashboard)/setup/page.tsx").includes("shellPublishCheck("), "Thiết lập: dòng kiểm xuất bản có câu của vỏ");
  assert.ok(src("app/(dashboard)/ai/sales-chatbot/page.tsx").includes('shell ? "Khung thử" : "Khung thử (TEST)"'), "AI Sales: «Khung thử (TEST)» có bản vỏ");
  // Không ghi cứng «Chốt Đơn» trong client component (không biết host) — dùng chữ trung tính.
  for (const f of ["app/(dashboard)/ai/sales-chatbot/history-panel.tsx", "app/(dashboard)/ai/sales-chatbot/order-sync-panel.tsx"]) {
    const code = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!code.includes('"Chốt Đơn"'), `${f}: client component không ghi cứng «Chốt Đơn»`);
  }
  return files.length;
}

export function testShellCopyR3() {
  testBrandAfterRedirect();
  const n = testShellCopy();
  console.log(
    `  ✓ vỏ Chốt Đơn: /login sau redirect() mang thương hiệu (gợi ý ?brand= danh sách trắng, host đã biết thắng) · ${n} tệp vỏ không lộ webhook / token / ERP / API / TEST / field / connector / module / Viettel ở nhánh khách thấy`,
  );
}

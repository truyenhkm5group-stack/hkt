/**
 * ═══════════ HƯỚNG DẪN SỬ DỤNG KHÔNG ĐƯỢC NÓI SAI VỀ MÀN HÌNH (lib/constants/help-guides.ts) ═══════════
 *
 * Một bài hướng dẫn chỉ tới nút không còn tồn tại tệ hơn không có bài: khách làm theo, không thấy, gọi hỗ trợ. Khoá ở
 * mức mã nguồn:
 *  1. Mọi đường dẫn (của bài và từng bước) trỏ tới một `app/(dashboard)/…/page.tsx` CÓ THẬT.
 *  2. Quyền khai ở bài TRÙNG quyền mà chính trang chính đòi (`requirePermission("…")` / `requireResource(…, "…")`); trang chỉ `requireUser()` thì bài
 *     không được khai quyền.
 *  3. Mọi tên nút / tên ô đặt trong «…» xuất hiện NGUYÊN VĂN trong mã đã vào kho (app/ + components/ + nhãn ở
 *     lib/constants/), trừ chính sổ hướng dẫn.
 *  4. Lọc hiển thị: thiếu quyền / module tắt / bài của tổ chức khách ở tổ chức nhà ⇒ ẩn.
 *  5. Có lối vào: menu tài khoản trỏ `/help`, và `/help` thuộc lõi (mọi tổ chức).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { PERMISSION_GROUPS } from "@/lib/auth/permissions";
import { HELP_FAQ, HELP_GUIDES, HELP_TOPIC_LABEL, HELP_TOPIC_ORDER, helpGuideVisible } from "@/lib/constants/help-guides";
import { moduleOfPath } from "@/lib/constants/platform-modules";

function pageFileOf(href: string): string {
  const path = href.split(/[?#]/)[0];
  return path === "/" ? "app/(dashboard)/page.tsx" : `app/(dashboard)${path}/page.tsx`;
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
    const src = readFileSync(pageFileOf(g.href), "utf8");
    const required = [...src.matchAll(/(?:requirePermission\(|requireResource\("[A-Z_]+",\s*)"([^"]+)"\)/g)].map((m) => m[1]);
    if (g.permission) {
      assert.ok(known.has(g.permission), `${g.key}: khoá quyền lạ ${g.permission}`);
      assert.ok(required.includes(g.permission), `${g.key}: trang ${g.href} đòi ${JSON.stringify(required)}, bài khai ${g.permission}`);
    } else {
      assert.deepEqual(required, [], `${g.key}: trang ${g.href} đòi quyền ${JSON.stringify(required)} mà bài không khai — bài sẽ hiện cho người không vào được`);
    }
  }

  // 3: tên nút trong «…» có thật trong mã giao diện đã vào kho.
  const ui = execFileSync("git", ["ls-files", "app", "components", "lib/constants"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && f !== "lib/constants/help-guides.ts")
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const texts = [...HELP_GUIDES.flatMap((g) => [g.summary, ...g.steps.map((s) => s.text)]), ...HELP_FAQ.flatMap((f) => [f.q, f.a])];
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

  // 5: lối vào + thuộc lõi.
  assert.equal(moduleOfPath("/help"), "core", "/help thuộc lõi — mọi tổ chức mở được");
  assert.ok(readFileSync("components/nav-user.tsx", "utf8").includes('href="/help"'), "menu tài khoản có lối vào /help");
  assert.ok(/requireUser\(\)/.test(readFileSync("app/(dashboard)/help/page.tsx", "utf8")), "/help chỉ cần đăng nhập");

  console.log(`  ✓ hướng dẫn sử dụng: ${HELP_GUIDES.length} bài trỏ tới trang có thật, quyền khớp trang, mọi tên nút «…» có trong mã; lọc theo quyền / module / tổ chức khách; lối vào từ menu tài khoản`);
}

/**
 * ═══════════ TRANG GIỚI THIỆU Ở TÊN MIỀN GỐC (`vnxcommerce.com`) ═══════════
 *
 * Ba điều phải đúng mãi, vì sai thì hỏng một cách KHÔNG ai thấy ngay:
 *  · tên miền gốc KHÔNG BAO GIỜ dựng dashboard — mọi đường dẫn ngoài trang giới thiệu chuyển sang ERP, `/api/*` ra 404
 *    (webhook gọi nhầm host phải thấy lỗi, không được bị chuyển hướng im lặng);
 *  · «Đăng ký» / «Đăng nhập» đi tới `APP_URL` và GIỮ query (`?invite=` của lời mời); `APP_URL` trỏ ngược về tên miền gốc
 *    thì không được chuyển vòng tròn;
 *  · giá in trên trang là giá trong `platform_plans`, gói không bán (`price_vnd NULL`) không bao giờ in thành 0 ₫.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_PLAN_KEY } from "@/lib/entitlements/check";
import { DEFAULT_SITE_DOMAIN, SITE_PAGE_PATH, siteAppOrigin, siteDomainFrom, siteHostKind, siteRoute } from "@/lib/platform/site-host";
import { getPublicSiteData } from "@/lib/queries/public-site";

export function testPublicSiteHost() {
  // ─── Đọc biến SITE_DOMAIN ───
  assert.equal(siteDomainFrom(undefined), DEFAULT_SITE_DOMAIN, "chưa khai ⇒ mặc định");
  assert.equal(siteDomainFrom("  "), DEFAULT_SITE_DOMAIN, "rỗng ⇒ mặc định");
  assert.equal(siteDomainFrom("off"), null, "off ⇒ tắt trang giới thiệu");
  assert.equal(siteDomainFrom("https://VNXcommerce.com/"), "vnxcommerce.com", "bỏ giao thức, dấu / cuối, chữ hoa");
  assert.equal(siteDomainFrom("vnx commerce.com"), null, "ký tự lạ ⇒ không đoán");
  assert.equal(siteDomainFrom("localhost"), null, "phải có ít nhất một dấu chấm");

  // ─── Nhận diện host ───
  const d = "vnxcommerce.com";
  assert.equal(siteHostKind("vnxcommerce.com", d), "APEX");
  assert.equal(siteHostKind("VNXcommerce.com:443", d), "APEX", "bỏ cổng, không phân biệt hoa thường");
  assert.equal(siteHostKind("www.vnxcommerce.com", d), "WWW");
  assert.equal(siteHostKind("erp.vnxcommerce.com", d), null, "host ERP KHÔNG phải trang giới thiệu");
  assert.equal(siteHostKind("hslc.erp.vnxcommerce.com", d), null, "tên miền con của tổ chức không phải trang giới thiệu");
  assert.equal(siteHostKind("evilvnxcommerce.com", d), null, "đuôi trùng chữ không phải cùng tên miền");
  assert.equal(siteHostKind("vnxcommerce.com", null), null, "tắt ⇒ không host nào khớp");

  // ─── Gốc ERP ───
  assert.equal(siteAppOrigin("https://erp.vnxcommerce.com/", d), "https://erp.vnxcommerce.com");
  assert.equal(siteAppOrigin("https://vnxcommerce.com", d), null, "APP_URL trỏ về chính tên miền gốc ⇒ không chuyển vòng tròn");
  assert.equal(siteAppOrigin("https://www.vnxcommerce.com", d), null);
  assert.equal(siteAppOrigin("javascript:alert(1)", d), null, "chỉ nhận http(s)");
  assert.equal(siteAppOrigin("", d), null);

  // ─── Quyết định từng đường dẫn ───
  const app = "https://erp.vnxcommerce.com";
  const r = (pathname: string, search = "", host: "APEX" | "WWW" = "APEX", appOrigin: string | null = app) => siteRoute({ host, pathname, search, siteDomain: d, protocol: "https:", appOrigin });

  assert.deepEqual(r("/"), { kind: "REWRITE", path: SITE_PAGE_PATH }, "/ ⇒ trang giới thiệu");
  assert.deepEqual(r(SITE_PAGE_PATH, "?utm=a"), { kind: "REDIRECT", url: "https://vnxcommerce.com/?utm=a", status: 308 }, "một địa chỉ cho một trang");
  assert.deepEqual(r("/blog", "?x=1", "WWW"), { kind: "REDIRECT", url: "https://vnxcommerce.com/blog?x=1", status: 301 }, "www ⇒ tên miền gốc, giữ đường dẫn");
  assert.deepEqual(r("/dang-ky", "?invite=AB-CD"), { kind: "REDIRECT", url: `${app}/start?invite=AB-CD`, status: 302 }, "đăng ký ⇒ /start của ERP, giữ mã mời");
  assert.deepEqual(r("/dang-nhap/"), { kind: "REDIRECT", url: `${app}/login`, status: 302 }, "đăng nhập ⇒ /login của ERP");
  assert.deepEqual(r("/login", "?next=%2Forders"), { kind: "REDIRECT", url: `${app}/login?next=%2Forders`, status: 302 }, "phiên đăng nhập sống ở host ERP, không ở tên miền gốc");
  assert.deepEqual(r("/orders"), { kind: "REDIRECT", url: `${app}/orders`, status: 302 }, "tên miền gốc không bao giờ dựng dashboard");
  assert.deepEqual(r("/api/webhooks/viettelpost"), { kind: "NOT_FOUND" }, "webhook gọi nhầm host phải thấy lỗi");
  assert.deepEqual(r("/api"), { kind: "NOT_FOUND" });
  assert.deepEqual(r("/_next/static/chunks/a.js"), { kind: "PASS" }, "tài nguyên tĩnh của trang");
  assert.deepEqual(r("/icon.svg"), { kind: "PASS" });

  // Mọi đích chuyển hướng TUYỆT ĐỐI: `request.url` của middleware mang host Next tự đặt, không phải host khách gõ.
  for (const p of ["/", SITE_PAGE_PATH, "/dang-ky", "/orders", "/x"]) {
    for (const o of [app, null]) {
      const v = r(p, "", "APEX", o);
      if (v.kind === "REDIRECT") assert.match(v.url, /^https?:\/\//, `${p} phải chuyển tới URL tuyệt đối`);
    }
  }
  assert.equal((siteRoute({ host: "WWW", pathname: "/", search: "", siteDomain: d, protocol: "http:", appOrigin: app }) as { url: string }).url, "http://vnxcommerce.com/", "giữ giao thức khi chạy thử http");

  // Thiếu gốc ERP hợp lệ: không chuyển đi đâu lạ, không mở dashboard.
  assert.deepEqual(r("/dang-ky", "?invite=X", "APEX", null), { kind: "REDIRECT", url: "https://vnxcommerce.com/start?invite=X", status: 302 });
  assert.deepEqual(r("/start", "", "APEX", null), { kind: "PASS" });
  assert.deepEqual(r("/orders", "", "APEX", null), { kind: "REDIRECT", url: "https://vnxcommerce.com/", status: 302 });
}

export function testPublicSiteSource() {
  const mw = readFileSync("middleware.ts", "utf8");
  // Khối tên miền gốc phải đứng TRƯỚC phép kiểm phiên — đứng sau thì người lạ vào `vnxcommerce.com` bị đẩy ra /login.
  const iSite = mw.indexOf("siteRoute(");
  const iToken = mw.indexOf("request.cookies.get(COOKIE)");
  assert.ok(iSite > 0 && iToken > iSite, "middleware phải xử lý tên miền gốc trước khi đọc phiên");
  const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES"), mw.indexOf("]", mw.indexOf("const PUBLIC_PREFIXES")));
  assert.ok(list.includes("SITE_PAGE_PATH"), "trang giới thiệu phải xem trước được trên host ERP khi chưa đăng nhập");

  // Trang công khai chỉ đọc gói cước + chế độ đăng ký: không import truy vấn dữ liệu khách nào.
  const q = readFileSync("lib/queries/public-site.ts", "utf8");
  const imports = [...q.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["@/lib/entitlements/check", "@/lib/entitlements/kinds", "@/lib/env", "@/lib/onboarding/service", "@/lib/onboarding/shared"], "public-site chỉ được đọc gói cước, chế độ đăng ký và APP_URL");
  const page = readFileSync("app/gioi-thieu/page.tsx", "utf8");
  assert.ok(!/@\/db|lib\/queries\/(?!public-site)/.test(page), "trang giới thiệu không được đọc CSDL / truy vấn nào khác");

  // Caddy: tên miền gốc xin chứng chỉ THEO YÊU CẦU — không đốt hạn mức Let's Encrypt trước ngày DNS trỏ về.
  const caddy = readFileSync("deploy/Caddyfile", "utf8");
  const block = caddy.slice(caddy.indexOf("{$SITE_DOMAIN"));
  assert.ok(block.length > 20 && /tls\s*\{\s*on_demand\s*\}/.test(block), "khối tên miền gốc phải dùng on_demand TLS");
  const route = readFileSync("app/api/platform/domain-allowed/route.ts", "utf8");
  assert.ok(route.includes("siteHostKind("), "cửa hỏi chứng chỉ phải nhận đúng host của trang giới thiệu");

  /*
    TRẦN ĐĂNG KÝ ĐI TỪ GITHUB VARIABLE TỚI .env. Trước 03/10/2026 deploy không ghi `PLATFORM_SIGNUP_MODE`, nên trần luôn
    là mặc định `invite` và nút «Mở» ở /platform báo «vượt trần» mà không có đường nào nâng. Biến phải có mặt ở CẢ BA chỗ
    của bước SSH (env · envs · export) — thiếu một chỗ là biến không tới máy chủ, im lặng. Và Variable bị xoá thì dòng
    trong .env phải bị xoá theo, nếu không thì hạ trần bằng cách xoá Variable không hạ được gì.
  */
  const wf = readFileSync(".github/workflows/deploy-vps.yml", "utf8");
  assert.ok(wf.includes("PLATFORM_SIGNUP_MODE: ${{ vars.PLATFORM_SIGNUP_MODE }}"), "workflow đọc Variable PLATFORM_SIGNUP_MODE");
  assert.ok(/envs: [^\n]*\bPLATFORM_SIGNUP_MODE\b/.test(wf), "PLATFORM_SIGNUP_MODE có trong danh sách envs gửi qua SSH");
  assert.ok(/export [^\n]*\bPLATFORM_SIGNUP_MODE\b/.test(wf), "PLATFORM_SIGNUP_MODE được export cho bootstrap");
  const install = readFileSync("scripts/install-vps.sh", "utf8");
  const khoi = install.slice(install.indexOf('case "${PLATFORM_SIGNUP_MODE:-}" in'), install.indexOf("esac", install.indexOf('case "${PLATFORM_SIGNUP_MODE:-}" in')));
  assert.ok(khoi.length > 0, "install-vps.sh phải xử lý PLATFORM_SIGNUP_MODE");
  assert.ok(khoi.includes("off|invite|open) upsert_env PLATFORM_SIGNUP_MODE"), "ba giá trị hợp lệ được ghi nguyên");
  assert.ok(khoi.includes("\"\") sed -i -E '/^PLATFORM_SIGNUP_MODE=/d' .env"), "Variable rỗng ⇒ xoá dòng, trần về mặc định");
  assert.ok(khoi.includes("*) upsert_env PLATFORM_SIGNUP_MODE off"), "giá trị lạ ⇒ đóng đăng ký, không đoán");
}

export async function testPublicSiteData() {
  const data = await getPublicSiteData();
  assert.ok(data.signupUrl.endsWith("/start") && data.loginUrl.endsWith("/login"), "lối vào trỏ về tuyến thật của ERP");
  assert.ok(data.plans.length > 0, "CSDL thử có gói bán gieo sẵn (0187)");
  for (const p of data.plans) assert.ok(typeof p.priceVnd === "number" && p.priceVnd > 0, `gói ${p.key} đang bán phải có giá dương`);
  assert.ok(!data.plans.some((p) => p.key === DEFAULT_PLAN_KEY), "gói khởi điểm không bán, không lẫn vào bảng giá");
  assert.ok(data.starterPlan && data.starterPlan.key === DEFAULT_PLAN_KEY && data.starterPlan.priceVnd === null, "gói khởi điểm giữ giá NULL — không phải 0 ₫");
  const positions = data.plans.map((p) => p.key);
  assert.equal(new Set(positions).size, positions.length, "không gói nào in hai lần");
  assert.ok(data.signup === null || ["off", "invite", "open"].includes(data.signup), "chế độ đăng ký là một trong ba giá trị, hoặc CHƯA BIẾT");
  console.log("✓ Trang giới thiệu: định tuyến tên miền gốc, lối vào ERP, bảng giá đọc từ platform_plans");
}

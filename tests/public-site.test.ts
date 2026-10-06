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
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_PLAN_KEY } from "@/lib/entitlements/check";
import { appOriginForHost, redirectUri } from "@/lib/auth/oauth";
import { initialQuickBusinessType } from "@/lib/onboarding/quick-shared";
import { DAYS_PER_MONTH, estimateMissedOrders, MISSED_ORDERS_DEFAULTS, MISSED_ORDERS_LIMITS, normalizeMissedOrdersInput } from "@/lib/site/missed-orders";
import { robotsTxt, SITE_INDEXABLE_PATHS, sitemapXml } from "@/lib/site/seo";
import { messengerRedirectUri, messengerRedirectUris } from "@/lib/integrations/messenger/connect";
import { organizationLinkOrigin, productNameFor } from "@/lib/platform/org-links";
import {
  BRAND_ASSET_PREFIX,
  brandAppOrigin,
  brandFromHeader,
  brandIconPath,
  brandOfHost,
  CHOTDON_ASSETS,
  chotdonDomainFrom,
  DEFAULT_CHOTDON_DOMAIN,
  DEFAULT_SITE_DOMAIN,
  ERP_SITE_BRAND_HEADER,
  matchSite,
  SITE_PAGE_PATH,
  siteAppOrigin,
  siteDomainFrom,
  siteHostKind,
  siteRoute,
} from "@/lib/platform/site-host";
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
  assert.deepEqual(r("/chinh-sach-bao-mat"), { kind: "PASS" }, "chính sách quyền riêng tư phục vụ NGAY ở tên miền gốc — Google / Facebook đòi link trên tên miền đã khai");
  assert.deepEqual(r("/chinh-sach-bao-mat/"), { kind: "PASS" });
  assert.deepEqual(r("/dieu-khoan-su-dung"), { kind: "PASS" }, "điều khoản sử dụng cũng phục vụ ở tên miền gốc — Facebook đòi link điều khoản");
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

  // Trang công khai chỉ đọc gói cước (bảng giá đang niêm yết — sổ giá có phiên bản, 0225) + chế độ đăng ký: không import truy
  // vấn dữ liệu khách nào.
  const q = readFileSync("lib/queries/public-site.ts", "utf8");
  const imports = [...q.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["@/lib/entitlements/check", "@/lib/entitlements/kinds", "@/lib/env", "@/lib/onboarding/service", "@/lib/onboarding/shared", "@/lib/pricing/price-book"], "public-site chỉ được đọc gói cước, chế độ đăng ký và APP_URL");
  const page = readFileSync("app/gioi-thieu/page.tsx", "utf8");
  assert.ok(!/@\/db|lib\/queries\/(?!public-site)/.test(page), "trang giới thiệu không được đọc CSDL / truy vấn nào khác");

  // Caddy: tên miền gốc xin chứng chỉ THEO YÊU CẦU — không đốt hạn mức Let's Encrypt trước ngày DNS trỏ về.
  const caddy = readFileSync("deploy/Caddyfile", "utf8");
  const block = caddy.slice(caddy.indexOf("{$SITE_DOMAIN"));
  assert.ok(block.length > 20 && /tls\s*\{\s*on_demand\s*\}/.test(block), "khối tên miền gốc phải dùng on_demand TLS");
  const route = readFileSync("app/api/platform/domain-allowed/route.ts", "utf8");
  assert.ok(route.includes("matchSite("), "cửa hỏi chứng chỉ phải nhận đúng host của trang giới thiệu");

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

/**
 * CHỐT ĐƠN TỰ ĐỘNG (chủ nền tảng chốt 04/10/2026): `chotdontudong.com` + `www.` là mặt tiền bản Chốt Đơn, `app.` là phần
 * mềm — cùng app, cùng CSDL. Những điều phải đúng mãi:
 *  · thương hiệu chỉ MÁY CHỦ quyết (header đặt sau khi xoá `x-erp-*` của trình duyệt); giá trị lạ ⇒ `vnx`;
 *  · `app.<miền>` KHÔNG phải mặt tiền (không bị chuyển hướng như tên miền gốc) — nó là phần mềm;
 *  · OAuth chỉ nhận đúng hai gốc phần mềm, KHÔNG dựng `redirect_uri` từ header Host thô;
 *  · đăng ký trên host Chốt Đơn chọn sẵn «Chỉ cần AI bán hàng».
 */
export function testChotDonBrand() {
  const env = { SITE_DOMAIN: undefined, CHOTDON_DOMAIN: undefined, APP_URL: "https://erp.vnxcommerce.com", CHOTDON_APP_URL: undefined };
  assert.equal(chotdonDomainFrom(undefined), DEFAULT_CHOTDON_DOMAIN);
  assert.equal(chotdonDomainFrom("off"), null);
  assert.deepEqual(matchSite("chotdontudong.com", env), { brand: "chotdon", kind: "APEX", domain: "chotdontudong.com" });
  assert.deepEqual(matchSite("WWW.chotdontudong.com:443", env), { brand: "chotdon", kind: "WWW", domain: "chotdontudong.com" });
  assert.deepEqual(matchSite("vnxcommerce.com", env), { brand: "vnx", kind: "APEX", domain: "vnxcommerce.com" });
  assert.equal(matchSite("app.chotdontudong.com", env), null, "host phần mềm KHÔNG phải mặt tiền");
  assert.equal(matchSite("erp.vnxcommerce.com", env), null);
  assert.equal(matchSite("chotdontudong.com", { ...env, CHOTDON_DOMAIN: "off" }), null, "tắt ⇒ không khớp");
  assert.deepEqual(matchSite("vnxcommerce.com", { ...env, CHOTDON_DOMAIN: "vnxcommerce.com" })?.brand, "vnx", "khai trùng tên miền ⇒ mặt tiền cũ không đổi chủ");

  assert.equal(brandOfHost("app.chotdontudong.com", env), "chotdon");
  assert.equal(brandOfHost("chotdontudong.com", env), "chotdon");
  assert.equal(brandOfHost("erp.vnxcommerce.com", env), "vnx");
  assert.equal(brandOfHost("app.chotdontudong.com.evil.com", env), "vnx", "đuôi giả mạo không thành thương hiệu");
  assert.equal(brandOfHost(null, env), "vnx");
  assert.equal(brandOfHost("app.chotdontudong.com", { ...env, CHOTDON_DOMAIN: "off" }), "vnx");
  assert.equal(brandFromHeader("chotdon"), "chotdon");
  assert.equal(brandFromHeader("CHOTDON"), "vnx", "giá trị lạ ⇒ vnx, không đoán");
  assert.equal(brandFromHeader(null), "vnx");

  assert.equal(brandAppOrigin("chotdon", env), "https://app.chotdontudong.com");
  assert.equal(brandAppOrigin("chotdon", { ...env, CHOTDON_APP_URL: "https://ban.chotdontudong.com/" }), "https://ban.chotdontudong.com");
  assert.equal(brandAppOrigin("chotdon", { ...env, CHOTDON_APP_URL: "https://chotdontudong.com" }), null, "gốc phần mềm trỏ về chính mặt tiền ⇒ không chuyển vòng tròn");
  assert.equal(brandAppOrigin("vnx", env), "https://erp.vnxcommerce.com");

  // Mặt tiền Chốt Đơn dẫn vào phần mềm của chính nó, giữ query.
  const r = siteRoute({ host: "APEX", pathname: "/dang-ky", search: "?nganh=ai_sales", siteDomain: "chotdontudong.com", protocol: "https:", appOrigin: brandAppOrigin("chotdon", env) });
  assert.deepEqual(r, { kind: "REDIRECT", url: "https://app.chotdontudong.com/start?nganh=ai_sales", status: 302 });
  assert.deepEqual(siteRoute({ host: "APEX", pathname: "/", search: "", siteDomain: "chotdontudong.com", protocol: "https:", appOrigin: null }), { kind: "REWRITE", path: SITE_PAGE_PATH });

  // OAuth: đường quay về theo gốc phần mềm của host — chỉ hai gốc trong danh sách.
  assert.equal(redirectUri("google", "https://app.chotdontudong.com/"), "https://app.chotdontudong.com/login/oauth/google/callback");
  const keys = ["SITE_DOMAIN", "CHOTDON_DOMAIN", "CHOTDON_APP_URL"] as const;
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(appOriginForHost("app.chotdontudong.com"), "https://app.chotdontudong.com");
    assert.equal(appOriginForHost("evil.example"), env_appUrl(), "host lạ ⇒ APP_URL, không dựng từ Host thô");
    assert.equal(appOriginForHost(null), env_appUrl());
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }

  // Đăng ký nhanh: ?nganh= hợp lệ thắng, host Chốt Đơn chọn sẵn AI bán hàng, giá trị lạ ⇒ mặc định.
  assert.equal(initialQuickBusinessType(undefined, "chotdon"), "ai_sales");
  assert.equal(initialQuickBusinessType(undefined, "vnx"), "food");
  assert.equal(initialQuickBusinessType("spa", "chotdon"), "spa");
  assert.equal(initialQuickBusinessType("manufacturing", "vnx"), "food", "ngành không có ở form nhanh ⇒ mặc định");

  // Gác mã nguồn.
  const mw = readFileSync("middleware.ts", "utf8");
  const iStrip = mw.indexOf("for (const name of clientSent) headers.delete(name);");
  const iBrand = mw.indexOf("headers.set(ERP_SITE_BRAND_HEADER");
  assert.ok(iStrip > 0 && iBrand > iStrip, "header thương hiệu đặt SAU khi xoá x-erp-* của trình duyệt");
  assert.ok(ERP_SITE_BRAND_HEADER.startsWith("x-erp-"), "header thương hiệu phải nằm trong vùng x-erp-* bị xoá");
  const caddy = readFileSync("deploy/Caddyfile", "utf8");
  const block = caddy.slice(caddy.indexOf("{$CHOTDON_DOMAIN"));
  assert.ok(block.includes("app.{$CHOTDON_DOMAIN") && /tls\s*\{\s*on_demand\s*\}/.test(block), "khối Chốt Đơn: mặt tiền + app, chứng chỉ theo yêu cầu");
  const allowed = readFileSync("app/api/platform/domain-allowed/route.ts", "utf8");
  assert.ok(allowed.includes("matchSite(") && allowed.includes("chotdonAppHost("), "cửa hỏi chứng chỉ nhận đúng mặt tiền + host phần mềm Chốt Đơn");
  const cb = readFileSync("app/login/oauth/[provider]/callback/route.ts", "utf8");
  assert.ok(cb.includes("appOriginForHost(") && cb.includes("st.o !== origin"), "callback OAuth ở đúng host đã bắt đầu");
  assert.ok(!cb.includes("env.appUrl"), "callback OAuth không còn cố định APP_URL");
  console.log("✓ Chốt Đơn Tự Động: mặt tiền + app theo host, thương hiệu chỉ máy chủ đặt, OAuth hai gốc trong danh sách, đăng ký chọn sẵn AI bán hàng");
}

function env_appUrl(): string {
  return (process.env.APP_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * MÁY TÍNH «SHOP BẠN ĐANG ĐỂ LỌT BAO NHIÊU ĐƠN?» (bản Chốt Đơn). Số ra từ số KHÁCH NHẬP — không một số liệu khách hàng nào
 * của nền tảng; đơn làm tròn XUỐNG (không thổi phồng); không có giá để so thì KHÔNG đoán một giá; trang luôn kèm nhãn
 * "ước tính … không phải cam kết doanh thu".
 */
export function testMissedOrdersCalculator() {
  const d = MISSED_ORDERS_DEFAULTS;
  const r = estimateMissedOrders(d, 249_000);
  assert.equal(r.unattendedChatsPerMonth, Math.round(d.chatsPerDay * (d.unattendedPct / 100) * DAYS_PER_MONTH));
  assert.equal(r.ordersPerMonth, Math.floor(r.unattendedChatsPerMonth * (d.closeRatePct / 100)), "đơn làm tròn xuống");
  assert.equal(r.revenuePerMonthVnd, r.ordersPerMonth * d.avgOrderVnd);
  assert.equal(r.timesPlanPrice, Math.floor((r.revenuePerMonthVnd / 249_000) * 10) / 10);
  // 60 khách/ngày · 30% không ai trả lời kịp · 8% chốt · 350.000 ₫ ⇒ 540 khách · 43 đơn · 15.050.000 ₫
  assert.deepEqual([r.unattendedChatsPerMonth, r.ordersPerMonth, r.revenuePerMonthVnd], [540, 43, 15_050_000]);
  assert.equal(estimateMissedOrders(d, null).timesPlanPrice, null, "không có giá ⇒ không so");
  assert.equal(estimateMissedOrders(d, 0).timesPlanPrice, null);
  assert.equal(estimateMissedOrders({ ...d, unattendedPct: 0 }).ordersPerMonth, 0, "ai cũng được trả lời kịp ⇒ không lọt đơn nào");
  const kep = normalizeMissedOrdersInput({ chatsPerDay: -5, unattendedPct: 250, closeRatePct: Number.NaN, avgOrderVnd: 1e12 });
  assert.deepEqual(kep, {
    chatsPerDay: MISSED_ORDERS_LIMITS.chatsPerDay.min,
    unattendedPct: MISSED_ORDERS_LIMITS.unattendedPct.max,
    closeRatePct: MISSED_ORDERS_LIMITS.closeRatePct.min,
    avgOrderVnd: MISSED_ORDERS_LIMITS.avgOrderVnd.max,
  }, "giá trị ngoài khoảng bị kẹp, NaN về mức thấp nhất");
  const ui = readFileSync("components/site/missed-orders-calculator.tsx", "utf8");
  assert.ok(ui.includes("không phải cam kết doanh thu"), "máy tính luôn nói rõ đây là ước tính");
  const page = readFileSync("app/gioi-thieu/page.tsx", "utf8");
  assert.ok(page.includes("SERVICE_COMMITMENTS.firstPaymentRefundDays") && page.includes("SERVICE_COMMITMENTS.retainAfterExpiryDays"), "cam kết trên trang đọc từ hằng số Điều khoản, không gõ lại số");
  console.log("✓ Máy tính đơn lọt: số từ số khách nhập, đơn làm tròn xuống, không giá thì không so, ngoài khoảng bị kẹp; cam kết đọc từ hằng số");
}

/**
 * BỘ BIỂU TƯỢNG + ROBOTS/SITEMAP CỦA CHỐT ĐƠN. Lỗi gốc (đo 05/10/2026): biểu tượng nằm ở `/chotdon-icon.svg`, mặt tiền
 * chuyển nó sang `app.`, `app.` đòi đăng nhập ⇒ tab không có biểu tượng ở cả hai host, còn `/favicon.ico` trả logo của
 * VNXcommerce. Bài này giữ: tài nguyên thương hiệu công khai ở CẢ HAI lớp định tuyến, biểu tượng mặc định đổi theo host,
 * mọi tệp được khai đều có thật trong kho, và robots/sitemap chỉ liệt kê đường mặt tiền phục vụ tại chỗ.
 */
export function testChotDonAssets() {
  // 1) Biểu tượng mặc định theo thương hiệu; thương hiệu gốc giữ tệp của mình
  assert.equal(brandIconPath("chotdon", "/favicon.ico"), CHOTDON_ASSETS.favicon);
  assert.equal(brandIconPath("chotdon", "/apple-touch-icon.png"), CHOTDON_ASSETS.apple);
  assert.equal(brandIconPath("chotdon", "/apple-touch-icon-precomposed.png"), CHOTDON_ASSETS.apple);
  assert.equal(brandIconPath("chotdon", "/icon.svg"), CHOTDON_ASSETS.icon);
  assert.equal(brandIconPath("chotdon", "/"), null);
  assert.equal(brandIconPath("vnx", "/favicon.ico"), null, "VNXcommerce giữ nguyên favicon của nhà");

  // 2) Tài nguyên thương hiệu đi thẳng ở mặt tiền (không bị chuyển sang app.) — và công khai ở host phần mềm
  const r = siteRoute({ host: "APEX", pathname: CHOTDON_ASSETS.icon, search: "", siteDomain: "chotdontudong.com", protocol: "https:", appOrigin: "https://app.chotdontudong.com" });
  assert.deepEqual(r, { kind: "PASS" }, "mặt tiền phục vụ /brand/… tại chỗ");
  for (const p of ["/robots.txt", "/sitemap.xml", "/apple-touch-icon.png"]) {
    assert.deepEqual(siteRoute({ host: "APEX", pathname: p, search: "", siteDomain: "chotdontudong.com", protocol: "https:", appOrigin: "https://app.chotdontudong.com" }), { kind: "PASS" }, p);
  }
  const mw = readFileSync("middleware.ts", "utf8");
  const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES"), mw.indexOf("]", mw.indexOf("const PUBLIC_PREFIXES")));
  assert.ok(list.includes("BRAND_ASSET_PREFIX"), "host phần mềm (app.) không đòi đăng nhập cho /brand/…");
  assert.ok(Object.values(CHOTDON_ASSETS).every((p) => p.startsWith(BRAND_ASSET_PREFIX)), "mọi tài nguyên Chốt Đơn nằm dưới tiền tố công khai");
  assert.ok(!mw.includes("favicon.ico).*)"), "favicon.ico phải đi qua middleware thì mới đổi theo host được");
  assert.ok(mw.includes("brandIconPath("), "middleware thay biểu tượng mặc định theo host");

  // 3) Mọi tệp được khai có thật trong kho; ICO mang đủ ba cỡ
  for (const p of Object.values(CHOTDON_ASSETS)) assert.ok(existsSync(`public${p}`), `thiếu public${p}`);
  const ico = readFileSync(`public${CHOTDON_ASSETS.favicon}`);
  assert.equal(ico.readUInt16LE(2), 1, "tệp ICO");
  assert.deepEqual([0, 1, 2].map((i) => ico[6 + i * 16]), [16, 32, 48], "favicon.ico mang 16 · 32 · 48");
  const manifest = JSON.parse(readFileSync(`public${CHOTDON_ASSETS.manifest}`, "utf8")) as { start_url: string; icons: { src: string; purpose?: string }[] };
  assert.equal(manifest.start_url, "/", "start_url cùng gốc với trang — URL khác gốc bị trình duyệt bỏ qua");
  for (const i of manifest.icons) assert.ok(existsSync(`public${i.src}`), `manifest trỏ tới tệp không có: ${i.src}`);
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"), "có biểu tượng maskable cho Android");
  assert.ok(!existsSync("public/chotdon-icon.svg"), "không để hai bản biểu tượng song song");

  // 4) robots/sitemap: chỉ đường phục vụ tại chỗ, URL tuyệt đối theo đúng tên miền
  assert.deepEqual([...SITE_INDEXABLE_PATHS], ["/", "/chinh-sach-bao-mat", "/dieu-khoan-su-dung"]);
  const robots = robotsTxt("chotdontudong.com");
  assert.ok(robots.includes("Sitemap: https://chotdontudong.com/sitemap.xml") && robots.includes("Disallow: /api/"));
  const xml = sitemapXml("chotdontudong.com");
  assert.equal((xml.match(/<loc>/g) ?? []).length, 3);
  assert.ok(xml.includes("<loc>https://chotdontudong.com/</loc>") && !xml.includes("/gioi-thieu") && !xml.includes("/login"), "không liệt kê đường bị chuyển sang phần mềm");
  for (const route of ["app/robots.txt/route.ts", "app/sitemap.xml/route.ts"]) {
    const src = readFileSync(route, "utf8");
    assert.ok(src.includes("matchSite(") && src.includes("status: 404"), `${route}: chỉ mặt tiền có tệp, host phần mềm vẫn 404`);
  }

  // 5) Trang giới thiệu khai ảnh chia sẻ + biểu tượng đủ bộ; nhãn logo không mang tên thương hiệu khác
  const page = readFileSync("app/gioi-thieu/page.tsx", "utf8");
  assert.ok(page.includes("CHOTDON_ASSETS.og") && page.includes('card: "summary_large_image"'), "link chia sẻ có ảnh lớn");
  assert.ok(page.includes("canonical"), "địa chỉ chuẩn cho công cụ tìm kiếm");
  assert.ok(!/ratingValue|aggregateRating|review/i.test(page.slice(page.indexOf("function chotdonJsonLd"), page.indexOf("function chotdonJsonLd") + 2000)), "dữ liệu có cấu trúc không khai điểm đánh giá chưa ai đo");
  assert.ok(page.includes('"Chốt Đơn Tự Động — về đầu trang"'), "logo bản Chốt Đơn không đọc thành VNXcommerce");
  const legal = readFileSync("components/legal/legal-page.tsx", "utf8");
  assert.ok(legal.includes("brand={brand}") && legal.includes("legalBrandName(brand)"), "văn bản pháp lý mang thương hiệu của host");
  console.log("✓ Chốt Đơn: biểu tượng đổi theo host + công khai ở cả hai lớp định tuyến, đủ tệp (ICO 16·32·48, iOS, maskable, ảnh chia sẻ), robots/sitemap chỉ ở mặt tiền");
}

/**
 * LIÊN KẾT THEO THƯƠNG HIỆU CỦA TỔ CHỨC (0215). Lỗi gốc: khách tự đăng ký ở app.chotdontudong.com nhận link mời, đặt lại
 * mật khẩu, tin Lark / Telegram trỏ erp.vnxcommerce.com — tên miền họ chưa từng đăng nhập (cookie phiên gắn với host), và
 * tin thử ghi cứng «VNXcommerce ERP». «Kết nối Messenger» bấm ở app. bị Facebook trả về erp. ⇒ mất phiên + state.
 */
export function testOrgLinkOrigin() {
  const ctx = { baseDomain: "erp.vnxcommerce.com", appUrl: "https://erp.vnxcommerce.com", chotdonOrigin: "https://app.chotdontudong.com" };
  const org = { isHome: false, publishState: null, domainSlug: null, brand: null } as const;
  assert.equal(organizationLinkOrigin({ ...org, brand: "chotdon" }, ctx), "https://app.chotdontudong.com", "khách Chốt Đơn ⇒ app.chotdontudong.com");
  assert.equal(organizationLinkOrigin({ ...org, brand: "vnx" }, ctx), ctx.appUrl);
  assert.equal(organizationLinkOrigin(org, ctx), ctx.appUrl, "không theo dõi (NULL) ⇒ APP_URL như trước, không đoán");
  assert.equal(organizationLinkOrigin({ ...org, brand: "chotdon", publishState: "PUBLISHED", domainSlug: "shop-a" }, ctx), "https://shop-a.erp.vnxcommerce.com", "đã xuất bản ⇒ tên miền con thắng");
  assert.equal(organizationLinkOrigin({ ...org, brand: "chotdon", publishState: "DRAFT", domainSlug: "shop-a" }, ctx), "https://app.chotdontudong.com", "còn nháp ⇒ chưa có tên miền con");
  assert.equal(organizationLinkOrigin({ ...org, isHome: true, brand: "chotdon" }, ctx), ctx.appUrl, "tổ chức nhà luôn APP_URL");
  assert.equal(organizationLinkOrigin({ ...org, brand: "chotdon" }, { ...ctx, chotdonOrigin: null }), ctx.appUrl, "tắt Chốt Đơn ⇒ APP_URL, không dựng gốc đoán");
  assert.equal(organizationLinkOrigin(null, ctx), ctx.appUrl);
  assert.equal(productNameFor("chotdon"), "Chốt Đơn Tự Động");
  assert.equal(productNameFor("vnx"), "VNXcommerce ERP");

  // Messenger: đường quay về theo gốc của lượt; trang người vận hành in đủ một đường cho mỗi gốc.
  assert.equal(messengerRedirectUri("https://app.chotdontudong.com/"), "https://app.chotdontudong.com/api/connect/messenger/callback");
  assert.ok(messengerRedirectUris().includes("https://app.chotdontudong.com/api/connect/messenger/callback"), "khai sẵn đường của app.chotdontudong.com");
  for (const route of ["app/api/connect/messenger/start/route.ts", "app/api/connect/messenger/callback/route.ts"]) {
    const src = readFileSync(route, "utf8");
    assert.ok(src.includes("appOriginForHost(") && src.includes("messengerRedirectUri(origin)") && !src.includes("env.appUrl"), `${route}: cả lượt đi theo gốc của host, không cố định APP_URL`);
  }

  // Đường gửi tin cho người của TỔ CHỨC không đọc APP_URL thẳng — chỉ còn ở nhánh dự phòng `.catch`.
  const senders = [
    "lib/alerts/notification-delivery.ts",
    "lib/alerts/owner-decision-digest.ts",
    "lib/alerts/stock-shortage-digest.ts",
    "lib/payroll/autopilot.ts",
    "lib/marketing/digest.ts",
    "lib/actions/marketing-alerts.ts",
    "lib/actions/alerts.ts",
  ];
  for (const f of senders) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("organizationBaseUrl("), `${f}: liên kết đi qua organizationBaseUrl`);
    const direct = src.split("\n").filter((l) => /process\.env\.APP_URL|env\.appUrl/.test(l) && !/\.catch\(/.test(l));
    assert.deepEqual(direct, [], `${f}: còn đọc APP_URL thẳng`);
  }
  assert.ok(!/VNXcommerce ERP/.test(readFileSync("lib/actions/alerts.ts", "utf8")), "tin thử / cảnh báo không ghi cứng tên thương hiệu");

  // Đăng ký: tầng action truyền thương hiệu của host; người vận hành tạo hộ ⇒ không ghi; chạy lại ⇒ không đổi.
  const actions = readFileSync("lib/actions/onboarding.ts", "utf8");
  assert.equal((actions.match(/hostBrand\(\)/g) ?? []).length, 2, "cả trình đầy đủ lẫn đăng ký nhanh truyền thương hiệu của host");
  const service = readFileSync("lib/onboarding/service.ts", "utf8");
  assert.ok(service.includes('brand: who.kind === "operator" ? null : (opts.brand ?? null)'), "người vận hành tạo hộ ⇒ không lấy host của người vận hành");
  assert.ok(service.includes("isNew: false, brand: null }"), "chạy lại lượt dựng hỏng không ghi thương hiệu");
  console.log("✓ Liên kết theo thương hiệu: Chốt Đơn ⇒ app.chotdontudong.com, xuất bản ⇒ tên miền con, không theo dõi ⇒ APP_URL; Messenger theo gốc host; 7 đường gửi tin không đọc APP_URL thẳng");
}

export async function testPublicSiteData() {
  const data = await getPublicSiteData();
  assert.ok(data.signupUrl.endsWith("/start") && data.loginUrl.endsWith("/login"), "lối vào trỏ về tuyến thật của ERP");
  assert.ok(data.plans.length > 0, "CSDL thử có gói bán gieo sẵn (0187)");
  for (const p of data.plans) assert.ok(typeof p.priceVnd === "number" && p.priceVnd > 0, `gói ${p.key} đang bán phải có giá dương`);
  // Ưu đãi trả năm in trên thẻ giá đọc từ `platform_plans.yearly_free_months` (0194), không gõ lại ở trang.
  for (const p of data.plans) assert.ok(Number.isInteger(p.yearlyFreeMonths) && p.yearlyFreeMonths >= 0 && p.yearlyFreeMonths <= 3, `gói ${p.key}: số tháng tặng khi trả năm phải là số nguyên 0–3`);
  // Nhãn "kèm AI cho trợ lý chat" đọc từ limits.ai của gói (0194 gieo credit cho mọi gói bán) — không gõ tay ở trang.
  assert.ok(data.plans.some((p) => p.aiIncluded), "CSDL thử có ít nhất một gói bán kèm credit AI (0194)");
  assert.ok(!data.plans.some((p) => p.key === DEFAULT_PLAN_KEY), "gói khởi điểm không bán, không lẫn vào bảng giá");
  assert.ok(data.starterPlan && data.starterPlan.key === DEFAULT_PLAN_KEY && data.starterPlan.priceVnd === null, "gói khởi điểm giữ giá NULL — không phải 0 ₫");
  const positions = data.plans.map((p) => p.key);
  assert.equal(new Set(positions).size, positions.length, "không gói nào in hai lần");
  assert.ok(data.signup === null || ["off", "invite", "open"].includes(data.signup), "chế độ đăng ký là một trong ba giá trị, hoặc CHƯA BIẾT");
  console.log("✓ Trang giới thiệu: định tuyến tên miền gốc, lối vào ERP, bảng giá đọc từ platform_plans");
}

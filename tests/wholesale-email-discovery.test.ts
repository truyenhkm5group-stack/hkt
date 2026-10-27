/**
 * ═══════════ THU THẬP EMAIL B2B TỪ WEBSITE CÔNG KHAI (lib/wholesale/email-discovery.ts) ═══════════
 *
 *  1. THUẦN — trích từng dạng (mailto nhiều địa chỉ, chữ, «[at] [dot]», «(at)», «at … dot …», thực thể HTML thập phân /
 *     thập lục phân / có tên, Cloudflare `data-cfemail`, JSON-LD Organization + contactPoint); loại rác (ảnh @2x, ví dụ,
 *     noreply, mã băm Sentry, hộp thư dùng một lần, email trong <script>); vai trò; chọn trang (ưu tiên, chân trang, cùng
 *     website, bỏ giỏ hàng); chọn email tốt nhất; quyết định điền ô.
 *  2. DNS GIẢ (không gọi mạng thật — AGENTS 65): MX · MX ngầm định qua A · NXDOMAIN · null MX · không bản ghi · lỗi DNS ·
 *     quá giờ ⇒ ba trạng thái; mỗi tên miền hỏi MỘT lần, có trần số tên miền.
 *  3. BỘ ĐỌC (fetch giả): robots.txt Disallow ⇒ không tải trang đó; chuyển hướng sang tên miền khác ⇒ KHÔNG một request
 *     nào tới website kia; trang liên hệ đọc trước.
 *  4. CSDL nhà: không đè ô nhân viên sửa; điền ô trống bằng email tốt nhất; thay email do máy điền trước; không đụng email
 *     từ tệp nhập; bộ lọc danh sách + độ phủ; nút «Thu thập email» xếp hàng không trùng, tôn trọng hạn quét lại.
 */
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decideScope } from "@/lib/auth/scope-guard";
import type { SessionUser } from "@/lib/auth/session";
import { EMAIL_RESCAN_DAYS, type EmailCheck } from "@/lib/constants/wholesale-email";
import { listWholesaleLeads, wholesaleEmailCoverage } from "@/lib/queries/wholesale";
import { parseListParams } from "@/lib/search-params";
import { DEFAULT_LEAD_HUNTER_CONFIG } from "@/lib/wholesale/config";
import {
  checkEmailDomain,
  checkEmailDomains,
  classifyEmailRole,
  decodeCloudflareEmail,
  emailFillDecision,
  emailScanOf,
  extractEmailCandidates,
  isJunkEmail,
  leadEmailRows,
  normalizeEmail,
  pickBestEmail,
  rankContactPages,
  sameSite,
  type EmailDns,
} from "@/lib/wholesale/email-discovery";
import { queueEmailDiscoveryCore } from "@/lib/wholesale/email-store";
import { enrichLeadWebsite } from "@/lib/wholesale/engine";
import type { EnrichmentProvider } from "@/lib/wholesale/providers";
import { websiteEnrichmentProvider } from "@/lib/wholesale/providers";
import type { EnrichResult } from "@/lib/wholesale/website";
import { enrichFromWebsite } from "@/lib/wholesale/website";

function cfEncode(email: string, key = 0x42): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return hex(key) + [...email].map((c) => hex(c.charCodeAt(0) ^ key)).join("");
}

const HOME = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Hải Sản Xanh","email":"mailto:info@haisanxanh.vn","contactPoint":[{"@type":"ContactPoint","contactType":"sales","email":"Sales@HaiSanXanh.vn"}]}</script>
<script type="application/ld+json">{ hỏng json </script>
<script>var tracker = "abc@evil-tracker.com";</script>
</head><body>
<a href="mailto:datban@haisanxanh.vn,ketoan@haisanxanh.vn?subject=Hỏi">Gửi thư</a>
<p>Mua hàng: thumua [at] haisanxanh [dot] vn · Đại lý: daily(at)haisanxanh.vn · Xuất khẩu: export at haisanxanh dot com dot vn</p>
<p>Nhân sự: tuyendung&#64;haisanxanh&#46;vn · Chị Lan: lan.nguyen&#x40;gmail.com · Bếp: bep&commat;haisanxanh.vn</p>
<p>Bảo vệ: <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cfEncode("hotro@haisanxanh.vn")}">[email&#160;protected]</a></p>
<p>logo@2x.png · noreply@haisanxanh.vn · you@example.com · 3f2a9c1b7d4e5f60718293a4b5c6d7e8@sentry.io · x@mailinator.com</p>
<!-- comment@hidden.vn -->
<nav><a href="/gioi-thieu">Giới thiệu</a> <a href="/blog/mon-ngon">Blog</a> <a href="/gio-hang">Giỏ hàng</a> <a href="https://other-site.vn/contact">Đối tác ngoài</a>
<a href="https://www.haisanxanh.vn/he-thong-dai-ly">Hệ thống</a> <a href="/san-pham?page=2">Sản phẩm</a> <a href="#top">Lên đầu</a></nav>
<footer><a href="/lien-he">Liên hệ</a> <a href="/impressum">Pháp lý</a></footer>
</body></html>`;

function testExtract() {
  const c = extractEmailCandidates(HOME, "https://haisanxanh.vn/");
  const emails = c.map((x) => x.email);
  const via = (e: string) => c.find((x) => x.email === e)?.via;
  for (const want of ["datban@haisanxanh.vn", "ketoan@haisanxanh.vn", "info@haisanxanh.vn", "sales@haisanxanh.vn", "thumua@haisanxanh.vn", "daily@haisanxanh.vn", "export@haisanxanh.com.vn", "tuyendung@haisanxanh.vn", "lan.nguyen@gmail.com", "bep@haisanxanh.vn", "hotro@haisanxanh.vn"]) {
    assert.ok(emails.includes(want), `thiếu ${want} — có: ${emails.join(", ")}`);
  }
  assert.equal(via("datban@haisanxanh.vn"), "MAILTO", "mailto nhiều địa chỉ, bỏ ?subject");
  assert.equal(via("ketoan@haisanxanh.vn"), "MAILTO");
  assert.equal(via("info@haisanxanh.vn"), "JSON_LD", "JSON-LD Organization.email (có tiền tố mailto:)");
  assert.equal(via("sales@haisanxanh.vn"), "JSON_LD", "JSON-LD contactPoint.email, chữ HOA ⇒ thường");
  assert.equal(via("thumua@haisanxanh.vn"), "OBFUSCATED", "«[at] [dot]»");
  assert.equal(via("daily@haisanxanh.vn"), "OBFUSCATED", "«(at)»");
  assert.equal(via("export@haisanxanh.com.vn"), "OBFUSCATED", "«at … dot … dot …»");
  assert.equal(via("tuyendung@haisanxanh.vn"), "TEXT", "thực thể thập phân &#64; &#46;");
  assert.equal(via("lan.nguyen@gmail.com"), "TEXT", "thực thể thập lục phân &#x40;");
  assert.equal(via("bep@haisanxanh.vn"), "TEXT", "thực thể có tên &commat;");
  assert.equal(via("hotro@haisanxanh.vn"), "CLOUDFLARE");
  for (const junk of ["abc@evil-tracker.com", "logo@2x.png", "noreply@haisanxanh.vn", "you@example.com", "x@mailinator.com", "comment@hidden.vn"]) assert.ok(!emails.includes(junk), `không được lấy ${junk}`);
  assert.ok(!emails.some((e) => e.endsWith("@sentry.io")), "mã băm Sentry");
  assert.ok(c.every((x) => x.sourceUrl === "https://haisanxanh.vn/"), "mỗi email mang URL nguồn");
  assert.equal(new Set(emails).size, emails.length, "mỗi email một lần");

  assert.equal(decodeCloudflareEmail(cfEncode("a@b.vn", 0x1f)), "a@b.vn");
  assert.equal(decodeCloudflareEmail("zz"), null);
  assert.equal(normalizeEmail(" MAILTO:Info%40Shop.VN?x=1 "), "info@shop.vn");
  assert.equal(normalizeEmail("a..b@shop.vn"), null);
  assert.equal(normalizeEmail("a@-shop.vn"), null);
  assert.equal(normalizeEmail("<sale@shop.vn>."), "sale@shop.vn");
  assert.ok(isJunkEmail("banner@home.jpg") && isJunkEmail("email@company.vn") && isJunkEmail("a@sub.wixpress.com"));
  assert.ok(!isJunkEmail("admin@haisanxanh.vn"), "admin là liên hệ chung, không phải rác");
  // Chữ «at» trần không kèm «dot» KHÔNG bị dịch thành @ (câu văn bình thường).
  assert.deepEqual(extractEmailCandidates("<p>Gặp nhau at quán lúc 7 giờ</p>", "https://x.vn/"), []);
}

function testRoles() {
  const site = "haisanxanh.vn";
  const cases: [string, string][] = [
    ["purchasing@x.vn", "PURCHASING"],
    ["procurement.team@x.vn", "PURCHASING"],
    ["thumua@x.vn", "PURCHASING"],
    ["mua-hang@x.vn", "PURCHASING"],
    ["buyer01@x.vn", "PURCHASING"],
    ["sales@x.vn", "SALES"],
    ["kinhdoanh@x.vn", "SALES"],
    ["b2b@x.vn", "SALES"],
    ["wholesale@x.vn", "SALES"],
    ["export@x.vn", "SALES"],
    ["info@x.vn", "GENERAL"],
    ["contact@x.vn", "GENERAL"],
    ["hello@x.vn", "GENERAL"],
    ["lienhe@x.vn", "GENERAL"],
    ["admin@x.vn", "GENERAL"],
    ["haisanxanh@gmail.com", "GENERAL"],
    ["lan.nguyen@gmail.com", "PERSONAL"],
    ["nguyenvana@gmail.com", "PERSONAL"],
    ["tuyendung@x.vn", "OTHER"],
    ["ketoan@x.vn", "OTHER"],
    ["zq81kk@x.vn", "OTHER"],
  ];
  for (const [e, role] of cases) assert.equal(classifyEmailRole(e, site), role, e);
}

function testPages() {
  const pages = rankContactPages(HOME, "https://haisanxanh.vn/", 10);
  assert.equal(pages[0], "https://haisanxanh.vn/lien-he", "liên hệ ở chân trang đứng đầu");
  assert.ok(pages.indexOf("https://www.haisanxanh.vn/he-thong-dai-ly") < pages.indexOf("https://haisanxanh.vn/gioi-thieu"), "đại lý trước giới thiệu");
  assert.ok(pages.includes("https://haisanxanh.vn/impressum"));
  assert.ok(!pages.some((p) => p.includes("other-site.vn")), "không theo sang tên miền khác");
  assert.ok(!pages.some((p) => /gio-hang|blog|san-pham/.test(p)), "chỉ trang liên hệ / giới thiệu — không bò khắp website");
  assert.deepEqual(rankContactPages(HOME, "https://haisanxanh.vn/", 2), ["https://haisanxanh.vn/lien-he", "https://www.haisanxanh.vn/he-thong-dai-ly"], "đúng trần N");
  assert.deepEqual(rankContactPages(HOME, "https://haisanxanh.vn/", 0), []);
  assert.ok(sameSite("www.a.vn", "a.vn") && !sameSite("a.vn", "b.a.vn") && !sameSite("a.vn", "a.vn.evil.com"));
}

function chk(email: string, over: Partial<EmailCheck> = {}): EmailCheck {
  return { email, role: classifyEmailRole(email, "shop.vn"), mx: "VALID_MX", mxVia: "MX", sameDomain: email.endsWith("@shop.vn"), sourceUrl: "https://shop.vn/lien-he", via: "MAILTO", ...over };
}

function testBest() {
  assert.equal(pickBestEmail([chk("info@shop.vn"), chk("sales@shop.vn"), chk("purchasing@shop.vn")])?.email, "purchasing@shop.vn", "mua hàng › kinh doanh › chung");
  assert.equal(pickBestEmail([chk("sales@gmail.com"), chk("sales@shop.vn")])?.email, "sales@shop.vn", "cùng tên miền thắng");
  assert.equal(pickBestEmail([chk("sales@shop.vn", { mx: "UNKNOWN", mxVia: null }), chk("sales@shop.vn.com", { sameDomain: true })])?.email, "sales@shop.vn.com", "VALID_MX thắng UNKNOWN");
  assert.equal(pickBestEmail([chk("purchasing@dead.vn", { mx: "NO_MX", mxVia: null }), chk("info@shop.vn")])?.email, "info@shop.vn", "NO_MX không bao giờ được chọn");
  assert.equal(pickBestEmail([chk("tuyendung@shop.vn"), chk("ketoan@shop.vn")]), null, "OTHER không tự điền");
  assert.equal(pickBestEmail([chk("lan.nguyen@gmail.com"), chk("tuyendung@shop.vn")])?.email, "lan.nguyen@gmail.com", "cá nhân vẫn hơn không có");
  assert.equal(pickBestEmail([]), null);

  assert.equal(emailFillDecision({ current: null, staffEdited: false, machineFilledBefore: false, best: "a@shop.vn" }), "a@shop.vn", "ô trống ⇒ điền");
  assert.equal(emailFillDecision({ current: "", staffEdited: true, machineFilledBefore: false, best: "a@shop.vn" }), null, "nhân viên đã sửa ⇒ không bao giờ");
  assert.equal(emailFillDecision({ current: "old@shop.vn", staffEdited: false, machineFilledBefore: true, best: "a@shop.vn" }), "a@shop.vn", "máy điền trước ⇒ thay");
  assert.equal(emailFillDecision({ current: "file@shop.vn", staffEdited: false, machineFilledBefore: false, best: "a@shop.vn" }), null, "không phải máy điền ⇒ giữ");
  assert.equal(emailFillDecision({ current: "a@shop.vn", staffEdited: false, machineFilledBefore: true, best: "a@shop.vn" }), null, "trùng ⇒ không ghi lại");
  assert.equal(emailFillDecision({ current: null, staffEdited: false, machineFilledBefore: false, best: null }), null);

  const scan = emailScanOf({ sources: [], emailChecks: [chk("sales@shop.vn"), { email: 1 }, { ...chk("x@shop.vn"), role: "LẠ" }], emailBest: "sales@shop.vn", emailVerifiedAt: "2026-10-27T01:00:00.000Z" });
  assert.equal(scan?.checks.length, 1, "dòng hỏng bị bỏ, không đoán");
  assert.equal(emailScanOf({ sources: [] }), null, "lượt cũ không có emailChecks");
  const rows = leadEmailRows(
    [
      { value: "old@shop.vn", sourceUrl: "https://shop.vn/cu", fetchedAt: new Date("2026-09-01T00:00:00Z") },
      { value: "sales@shop.vn", sourceUrl: "https://shop.vn/lien-he", fetchedAt: new Date("2026-10-01T00:00:00Z") },
    ],
    scan,
    "sales@shop.vn",
    "shop.vn",
  );
  assert.equal(rows[0]?.email, "sales@shop.vn");
  assert.ok(rows[0]?.inProfile && rows[0].inLatestScan && rows[0].verifiedAt === "2026-10-27T01:00:00.000Z");
  assert.equal(rows[1]?.mx, "UNKNOWN", "email không còn ở lượt mới nhất ⇒ MX CHƯA BIẾT, không phải hỏng");
  assert.equal(rows[1]?.verifiedAt, null);
}

function dnsErr(code: string) {
  return Object.assign(new Error(code), { code });
}

/** DNS GIẢ: bảng tên miền ⇒ bản ghi / mã lỗi; đếm số lượt hỏi. */
function fakeDns(table: Record<string, { mx?: { exchange: string; priority: number }[] | string; a?: string[] | string; aaaa?: string[] | string; hang?: boolean }>, calls: string[]): EmailDns {
  const pick = <T>(v: T[] | string | undefined, what: string, d: string): Promise<T[]> => {
    calls.push(`${what}:${d}`);
    if (table[d]?.hang) return new Promise<T[]>(() => undefined);
    if (v === undefined) return Promise.reject(dnsErr(table[d] ? "ENODATA" : "ENOTFOUND"));
    return typeof v === "string" ? Promise.reject(dnsErr(v)) : Promise.resolve(v);
  };
  return {
    resolveMx: (d) => pick(table[d]?.mx, "MX", d),
    resolve4: (d) => pick(table[d]?.a, "A", d),
    resolve6: (d) => pick(table[d]?.aaaa, "AAAA", d),
  };
}

async function testDns() {
  const calls: string[] = [];
  const dns = fakeDns(
    {
      "mx.vn": { mx: [{ exchange: "mail.mx.vn", priority: 10 }] },
      "aonly.vn": { a: ["113.161.1.1"] },
      "nullmx.vn": { mx: [{ exchange: ".", priority: 0 }], a: ["113.161.1.1"] },
      "bare.vn": {},
      "servfail.vn": { mx: "ESERVFAIL" },
      "a-fail.vn": { a: "ETIMEOUT" },
      "hang.vn": { hang: true },
    },
    calls,
  );
  assert.deepEqual(await checkEmailDomain("mx.vn", dns), { mx: "VALID_MX", mxVia: "MX" });
  assert.deepEqual(await checkEmailDomain("aonly.vn", dns), { mx: "VALID_MX", mxVia: "A" }, "không MX nhưng có A ⇒ MX ngầm định (RFC 5321)");
  assert.deepEqual(await checkEmailDomain("nullmx.vn", dns), { mx: "NO_MX", mxVia: null }, "null MX (RFC 7505) ⇒ không nhận thư dù có A");
  assert.deepEqual(await checkEmailDomain("khong-ton-tai.vn", dns), { mx: "NO_MX", mxVia: null }, "NXDOMAIN");
  assert.deepEqual(await checkEmailDomain("bare.vn", dns), { mx: "NO_MX", mxVia: null }, "không MX, không A/AAAA");
  assert.deepEqual(await checkEmailDomain("servfail.vn", dns), { mx: "UNKNOWN", mxVia: null }, "DNS lỗi ⇒ CHƯA BIẾT, không phải hỏng");
  assert.deepEqual(await checkEmailDomain("a-fail.vn", dns), { mx: "UNKNOWN", mxVia: null });
  assert.deepEqual(await checkEmailDomain("hang.vn", dns, 30), { mx: "UNKNOWN", mxVia: null }, "quá giờ ⇒ CHƯA BIẾT");

  calls.length = 0;
  const many = await checkEmailDomains(["a@x1.vn", "b@x1.vn", "c@x2.vn", "d@mx.vn", "e@x3.vn"], dns, { siteDomain: "mx.vn", maxDomains: 2 });
  assert.deepEqual(Object.keys(many), ["mx.vn", "x1.vn"], "tên miền website trước, đúng trần");
  assert.equal(calls.filter((c) => c === "MX:x1.vn").length, 1, "mỗi tên miền hỏi MỘT lần");
  assert.ok(!calls.some((c) => c.includes("x3.vn")), "quá trần ⇒ không hỏi");
}

async function testCrawl() {
  const calls: string[] = [];
  const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const fakeFetch = (async (input: string) => {
    calls.push(input);
    const u = new URL(input);
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /lien-he\n", { status: 200, headers: { "content-type": "text/plain" } });
    if (u.hostname === "moved.vn") return new Response("", { status: 301, headers: { location: "https://other-site.vn/" } });
    if (u.pathname === "/impressum") return new Response("", { status: 302, headers: { location: "https://other-site.vn/impressum" } });
    if (u.pathname === "/he-thong-dai-ly") return html(`<p>Đại lý: sales@haisanxanh.vn</p>`);
    if (u.pathname === "/gioi-thieu") return html(`<p>Thu mua: purchasing [at] haisanxanh [dot] vn</p>`);
    if (u.pathname === "/lien-he") return html(`<p>secret@haisanxanh.vn</p>`);
    return html(HOME);
  }) as unknown as typeof fetch;
  const resolve = async () => ["113.161.1.1"];
  const r = await enrichFromWebsite("https://haisanxanh.vn", { maxPages: 5 }, { fetch: fakeFetch, resolve });
  assert.equal(r.status, "DONE");
  assert.ok(!calls.some((c) => c.endsWith("/lien-he")), "robots.txt Disallow ⇒ không tải trang đó");
  assert.ok(!r.findings.some((f) => f.value === "secret@haisanxanh.vn"));
  assert.ok(!calls.some((c) => c.includes("other-site.vn")), "chuyển hướng sang website khác ⇒ KHÔNG một request nào tới đó");
  const emails = r.findings.filter((f) => f.kind === "EMAIL");
  assert.ok(emails.some((f) => f.value === "purchasing@haisanxanh.vn" && f.sourceUrl === "https://haisanxanh.vn/gioi-thieu" && f.via === "OBFUSCATED"));
  assert.ok(emails.some((f) => f.value === "sales@haisanxanh.vn"));
  assert.equal(r.pagesRead, 3, "trang chủ + đại lý + giới thiệu (liên hệ bị robots chặn, impressum chuyển sang website khác)");

  const moved = await enrichFromWebsite("https://moved.vn", { maxPages: 3 }, { fetch: fakeFetch, resolve });
  assert.equal(moved.status, "FAILED");
  assert.match(moved.note, /tên miền khác/);
  assert.ok(!calls.some((c) => c.includes("other-site.vn")));

  // Bộ đọc thật của job: email tìm được ⇒ hỏi DNS GIẢ (tiêm vào), không gọi mạng.
  const dnsCalls: string[] = [];
  const provider = websiteEnrichmentProvider({ fetch: fakeFetch, resolve, dns: fakeDns({ "haisanxanh.vn": { mx: [{ exchange: "mx.haisanxanh.vn", priority: 5 }] }, "gmail.com": { mx: [{ exchange: "gmail-smtp-in.l.google.com", priority: 5 }] } }, dnsCalls) });
  const pr = await provider.enrich("https://haisanxanh.vn", { maxPages: 2 });
  assert.equal(pr.emailDomains?.["haisanxanh.vn"]?.mx, "VALID_MX");
  assert.ok(dnsCalls.length > 0 && dnsCalls.every((c) => !c.includes("other-site")), "chỉ hỏi DNS tên miền của email");
}

// ─────────────────────────── 4. CSDL ───────────────────────────

async function testDb() {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const tag = `ed-${Date.now().toString(36)}`;
  const [u] = await db.insert(schema.users).values({ email: `${tag}@email-discovery.local`, name: "QT thu email", role: "ADMIN", passwordHash: "x", dataScope: "ALL" }).returning();
  const admin: SessionUser = { id: u!.id, email: u!.email, name: "QT thu email", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null };
  const noScan: SessionUser = { ...admin, role: "CS", permissions: ["wholesale:view", "wholesale:work"] };
  const site = `${tag}.vn`;
  const base = { source: "GOOGLE_PLACES", enrichmentStatus: "READY", website: `https://${site}`, websiteDomain: site } as const;
  const ids: string[] = [];
  const mk = async (over: Partial<typeof l.$inferInsert>) => {
    const [row] = await db.insert(l).values({ ...base, businessName: `Lead ${tag} ${ids.length}`, ...over }).returning();
    ids.push(row!.id);
    return row!;
  };
  try {
    const staff = await mk({ email: "sep@typed.vn", staffEditedFields: ["email"] });
    const empty = await mk({});
    const imported = await mk({ source: "MANUAL_IMPORT", email: "file@tep.vn" });
    const findings: EnrichResult["findings"] = [
      { kind: "EMAIL", value: `info@${site}`, sourceUrl: `https://${site}/`, via: "MAILTO" },
      { kind: "EMAIL", value: `purchasing@${site}`, sourceUrl: `https://${site}/lien-he`, via: "OBFUSCATED" },
      { kind: "EMAIL", value: "thumua@chet.vn", sourceUrl: `https://${site}/lien-he`, via: "TEXT" },
    ];
    let current: EnrichResult = { status: "DONE", pagesRead: 2, note: "Đọc 2 trang", findings, emailDomains: { [site]: { mx: "VALID_MX", mxVia: "MX" }, "chet.vn": { mx: "NO_MX", mxVia: null } } };
    const enricher: EnrichmentProvider = { key: "WEBSITE", label: "giả", role: "ENRICHMENT", googleSourced: false, billable: false, enrich: async () => current };
    const ctx = { cfg: DEFAULT_LEAD_HUNTER_CONFIG, now: () => new Date(), stats: [], enricher };
    const reload = async (id: string) => (await db.query.wholesaleLeads.findFirst({ where: eq(l.id, id) }))!;

    for (const lead of [staff, empty, imported]) await enrichLeadWebsite(ctx, await reload(lead.id));
    assert.equal((await reload(staff.id)).email, "sep@typed.vn", "KHÔNG đè ô nhân viên đã sửa");
    assert.equal((await reload(empty.id)).email, `purchasing@${site}`, "ô trống ⇒ email mua hàng cùng tên miền; NO_MX không được chọn dù cũng là mua hàng");
    assert.equal((await reload(imported.id)).email, "file@tep.vn", "email từ tệp nhập không phải của máy ⇒ giữ");
    const ers = await db.select().from(schema.wholesaleLeadEnrichments).where(eq(schema.wholesaleLeadEnrichments.leadId, empty.id));
    assert.equal(ers.filter((e) => e.kind === "EMAIL").length, 3, "mọi email (kể cả NO_MX) vẫn lưu làm bằng chứng, kèm URL nguồn");
    const acts = await db.select().from(schema.wholesaleLeadActivities).where(eq(schema.wholesaleLeadActivities.leadId, empty.id));
    const scan = acts.map((a) => emailScanOf(a.meta)).find((x) => x != null);
    assert.ok(scan, "lượt quét ghi vai trò + MX + ngày xác minh vào meta");
    assert.equal(scan.checks.find((c) => c.email === "thumua@chet.vn")?.mx, "NO_MX");
    assert.equal(scan.checks.find((c) => c.email === `purchasing@${site}`)?.role, "PURCHASING");

    // Lượt sau: email đang ở hồ sơ do MÁY điền ⇒ được thay khi có email tốt hơn; ô nhân viên sửa vẫn nguyên.
    await db.update(l).set({ email: `info@${site}` }).where(eq(l.id, empty.id));
    const prevMeta = acts.find((a) => emailScanOf(a.meta))!;
    await db.update(schema.wholesaleLeadActivities).set({ meta: { ...(prevMeta.meta as Record<string, unknown>), emailFilled: `info@${site}` } }).where(eq(schema.wholesaleLeadActivities.id, prevMeta.id));
    current = { ...current, findings: [...findings, { kind: "EMAIL", value: `sales@${site}`, sourceUrl: `https://${site}/dai-ly`, via: "MAILTO" }] };
    await enrichLeadWebsite(ctx, await reload(empty.id));
    assert.equal((await reload(empty.id)).email, `purchasing@${site}`, "máy điền trước ⇒ thay bằng email tốt nhất");
    await enrichLeadWebsite(ctx, await reload(staff.id));
    assert.equal((await reload(staff.id)).email, "sep@typed.vn");

    // Danh sách + độ phủ đọc đúng trạng thái MX / vai trò của email đang dùng.
    const decision = await decideScope("WHOLESALE_LEADS", admin);
    const listParams = (email: string) => parseListParams({ q: `Lead ${tag}`, email }, { defaultSort: "leadScore", filterKeys: ["view", "email"] });
    const listOf = async (email: string) => (await listWholesaleLeads(listParams(email), decision, admin.id)).rows.map((r) => r.id);
    assert.deepEqual(await listOf("valid"), [empty.id], "lọc «tên miền nhận thư»: email nhân viên gõ chưa qua lượt quét KHÔNG được coi là hợp lệ");
    assert.deepEqual(await listOf("role_PURCHASING"), [empty.id]);
    assert.deepEqual((await listOf("has")).sort(), [staff.id, empty.id, imported.id].sort());
    const row = (await listWholesaleLeads(listParams("valid"), decision, admin.id)).rows[0];
    assert.equal(row?.emailMx, "VALID_MX");
    assert.equal(row?.emailRole, "PURCHASING");
    const cov = await wholesaleEmailCoverage(decision);
    assert.ok(cov.validEmail >= 1 && cov.withEmail >= 3 && cov.withWebsite >= 3 && cov.total >= cov.withWebsite);

    // «Thu thập email»: chỉ lead có website, chưa email, chưa quét trong hạn; không xếp trùng.
    const fresh = await mk({});
    const recent = await mk({ websiteCheckedAt: new Date(Date.now() - 2 * 86_400_000) });
    const stale = await mk({ websiteCheckedAt: new Date(Date.now() - (EMAIL_RESCAN_DAYS + 1) * 86_400_000), websiteStatus: "DONE" });
    const fb = await mk({ website: "https://www.facebook.com/quan-abc", websiteDomain: null });
    const dnc = await mk({ contactStatus: "DO_NOT_CONTACT" });
    assert.ok("error" in (await queueEmailDiscoveryCore(noScan, {})), "không có wholesale:scan ⇒ từ chối");
    assert.ok("error" in (await queueEmailDiscoveryCore(admin, { limit: 0 })), "zod chặn số lạ");
    const q1 = await queueEmailDiscoveryCore(admin, { limit: 500 });
    assert.ok("ok" in q1, JSON.stringify(q1));
    const st = async (id: string) => (await reload(id)).websiteStatus;
    assert.equal(await st(fresh.id), "PENDING");
    assert.equal(await st(stale.id), "PENDING", "quét quá EMAIL_RESCAN_DAYS ⇒ được quét lại");
    assert.notEqual(await st(recent.id), "PENDING", "vừa quét chưa đủ hạn ⇒ không quét trùng");
    assert.notEqual(await st(fb.id), "PENDING", "website là trang Facebook ⇒ không đọc");
    assert.notEqual(await st(dnc.id), "PENDING", "không liên hệ ⇒ không đi thu thập");
    assert.notEqual(await st(staff.id), "PENDING", "đã có email ⇒ không vào");
    const q2 = await queueEmailDiscoveryCore(admin, { limit: 500 });
    assert.ok("ok" in q2 && "ok" in q1);
    assert.ok(q2.report.queued <= q1.report.queued - 2, "lần bấm thứ hai không xếp lại lead đang chờ");
    const back = await db.select({ id: l.id }).from(l).where(inArray(l.id, [fresh.id, stale.id]));
    assert.equal(back.length, 2);
  } finally {
    if (ids.length) await db.delete(l).where(inArray(l.id, ids));
    await db.delete(schema.users).where(eq(schema.users.id, u!.id));
  }
}

export async function testWholesaleEmailDiscovery() {
  testExtract();
  testRoles();
  testPages();
  testBest();
  await testDns();
  await testCrawl();
  await testDb();
  console.log("✓ Thu thập email B2B: mailto · JSON-LD · Cloudflare · dạng che · thực thể HTML · lọc rác · vai trò · chọn trang cùng website · robots · không theo tên miền khác · MX giả (không mạng) · email tốt nhất · không đè ô nhân viên · xếp hàng không trùng");
}

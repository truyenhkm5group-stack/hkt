import { Resolver as DnsResolver } from "node:dns/promises";
import {
  EMAIL_DNS_TIMEOUT_MS,
  EMAIL_MAX_PER_PAGE,
  EMAIL_MAX_PER_SITE,
  EMAIL_ROLE_RANK,
  isEmailMxStatus,
  isEmailRole,
  type EmailCheck,
  type EmailMxStatus,
  type EmailRole,
  type EmailVia,
} from "@/lib/constants/wholesale-email";

/**
 * ═══════════ THU THẬP EMAIL B2B TỪ WEBSITE CÔNG KHAI — HÀM THUẦN + LỚP DNS MỎNG ═══════════
 *
 * Nâng bộ đọc website (`website.ts` / `website-parse.ts`) thành bộ thu thập EMAIL CÓ BẰNG CHỨNG:
 *
 *  · CHỌN TRANG: trang chủ + vài trang CÙNG website xếp theo đường dẫn / chữ trên liên kết (liên hệ › đại lý / bán sỉ /
 *    mua hàng › giới thiệu › impressum), liên kết ở chân trang được cộng điểm. Không theo sang tên miền khác.
 *  · TRÍCH: `mailto:`, chữ thường, dạng che («name [at] domain [dot] com», «name(at)domain.com», «name at x dot com»),
 *    thực thể HTML (`&#64;`, `&#x40;`, `&commat;`), email Cloudflare che (`data-cfemail`), JSON-LD (`email` ở
 *    Organization / contactPoint). Bỏ email giả / ảnh / ví dụ / hộp thư hệ thống / tên miền thư rác dùng một lần.
 *  · PHÂN LOẠI vai trò từ phần trước @ (mua hàng › kinh doanh › liên hệ chung › cá nhân › khác).
 *  · KIỂM TÊN MIỀN bằng DNS (MX, thiếu MX thì A/AAAA theo RFC 5321) — KHÔNG gửi thư, KHÔNG mở kết nối SMTP, KHÔNG dò
 *    RCPT / VRFY. Hỏi máy chủ thư «hộp này có không» là việc của kẻ gửi thư rác, và bị chặn / đưa vào danh sách đen.
 *  · CHỌN email tốt nhất: vai trò › cùng tên miền website › tên miền nhận thư › nguồn chắc hơn.
 *
 * Mọi hàm trừ `systemEmailDns` / `checkEmailDomain(s)` là THUẦN. Phần DNS nhận resolver tiêm vào để bài kiểm không gọi
 * mạng thật (AGENTS mục 65). Thu thập ≠ được phép gửi: xem `EMAIL_CONSENT_NOTICE`.
 */

export type EmailCandidate = { email: string; sourceUrl: string; via: EmailVia };

// ─────────────────────────── giải mã ───────────────────────────

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".", lowbar: "_", hyphen: "-", dash: "-", plus: "+", percnt: "%" };

/** Thực thể HTML: có tên, thập phân, thập lục phân (`&#x40;` = @). */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Email Cloudflare «Email Address Obfuscation»: byte đầu là khoá XOR cho các byte sau. Hỏng ⇒ null. */
export function decodeCloudflareEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function stripToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/＠/g, "@")
    .replace(/\s+/g, " ");
}

/** Viết che ⇒ viết thường. Chỉ nhận dạng có ngoặc, hoặc «at … dot …» đủ cả hai vế (một chữ «at» trần thì không). */
export function deobfuscateEmailText(text: string): string {
  return text
    .replace(/\s*[[({]\s*(?:at|@|a còng|a cong)\s*[\])}]\s*/gi, "@")
    .replace(/\s*[[({]\s*(?:dot|\.|chấm|cham)\s*[\])}]\s*/gi, ".")
    .replace(/([a-z0-9._%+-])\s+@\s+([a-z0-9-])/gi, "$1@$2")
    .replace(/\b([a-z0-9._%+-]{1,64})\s+at\s+([a-z0-9-]{1,63}(?:\s+dot\s+[a-z0-9-]{1,63})+)\b/gi, (_, local: string, dom: string) => `${local}@${dom.replace(/\s+dot\s+/gi, ".")}`);
}

// ─────────────────────────── chuẩn hoá + lọc rác ───────────────────────────

const EMAIL_IN_TEXT = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}/gi;
const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?|ttf|bmp|tiff?|avif|mp4|webm|pdf|zip)$/i;
/** Tên miền mẫu / dịch vụ ghi lỗi / nền dựng web — địa chỉ ở đây không phải kênh liên hệ của doanh nghiệp. */
const JUNK_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "example.vn",
  "domain.com",
  "domain.vn",
  "email.com",
  "yourdomain.com",
  "yoursite.com",
  "yourcompany.com",
  "company.com",
  "mysite.com",
  "website.com",
  "sample.com",
  "test.com",
  "placeholder.com",
  "sentry.io",
  "wixpress.com",
  "wix.com",
  "sentry-next.wixpress.com",
];
/** Hộp thư dùng một lần — «chặn rác». */
const DISPOSABLE_DOMAINS = ["mailinator.com", "yopmail.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "trashmail.com", "sharklasers.com", "getnada.com", "maildrop.cc", "dispostable.com"];
const JUNK_LOCAL = /^(no-?reply|noreply|do-?not-?reply|donotreply|mailer-daemon|example|test|testing|user|username|your-?name|your-?email|yourmail|email|name|someone|johndoe|john\.doe|abc|xxx|xyz)$/;

function domainIn(domain: string, list: readonly string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Email giả / ảnh / ví dụ / hệ thống / dùng một lần. */
export function isJunkEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return true;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (ASSET_SUFFIX.test(domain) || /@\d+x\./.test(email)) return true;
  if (domainIn(domain, JUNK_DOMAINS) || domainIn(domain, DISPOSABLE_DOMAINS) || /(^|\.)example\./.test(domain)) return true;
  if (JUNK_LOCAL.test(local)) return true;
  if (/^[a-f0-9]{24,}$/.test(local)) return true; // mã băm (Sentry DSN…)
  return false;
}

/** Chuỗi thô (kể cả `mailto:`, mã hoá URL, ngoặc) ⇒ email chữ thường hợp lệ, hoặc null. */
export function normalizeEmail(raw: string): string | null {
  let s = raw.trim().replace(/^mailto:/i, "");
  s = s.split("?")[0] ?? "";
  try {
    s = decodeURIComponent(s);
  } catch {
    // giữ nguyên chuỗi khi mã hoá hỏng
  }
  s = s
    .replace(/＠/g, "@")
    .trim()
    .replace(/^[<"'(\s]+|[>"')\s.,;:]+$/g, "")
    .toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || s.indexOf("@") !== at) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!/^[a-z0-9._%+-]{1,64}$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) return null;
  return s;
}

export function emailDomainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Email cùng tên miền với website (kể cả tên miền con hai chiều: `shop.abc.vn` ↔ `abc.vn`). */
export function emailMatchesSite(email: string, siteDomain: string | null | undefined): boolean {
  if (!siteDomain) return false;
  const d = emailDomainOf(email);
  const s = siteDomain.toLowerCase().replace(/^www\./, "");
  return d === s || d.endsWith(`.${s}`) || s.endsWith(`.${d}`);
}

// ─────────────────────────── trích từ một trang ───────────────────────────

function collectJsonLdEmails(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length >= EMAIL_MAX_PER_PAGE * 2 || node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) collectJsonLdEmails(x, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.toLowerCase() === "email") {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
    } else if (typeof v === "object") collectJsonLdEmails(v, out, depth + 1);
  }
}

/** Mọi email doanh nghiệp công bố trên MỘT trang, mỗi email một lần, kèm URL nguồn và cách lấy được. */
export function extractEmailCandidates(html: string, pageUrl: string): EmailCandidate[] {
  const out: EmailCandidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string, via: EmailVia) => {
    if (out.length >= EMAIL_MAX_PER_PAGE) return;
    const e = normalizeEmail(raw);
    if (!e || isJunkEmail(e) || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, sourceUrl: pageUrl, via });
  };

  // 1. mailto: (có thể nhiều địa chỉ cách nhau bằng dấu phẩy / chấm phẩy).
  for (const m of html.matchAll(/\bhref\s*=\s*(?:"(mailto:[^"]*)"|'(mailto:[^']*)'|(mailto:[^\s>]+))/gi)) {
    const v = decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "").replace(/^mailto:/i, "").split("?")[0] ?? "";
    for (const part of v.split(/[,;]/)) add(part, "MAILTO");
  }
  // 2. JSON-LD (Organization.email, contactPoint.email…).
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const found: string[] = [];
    try {
      collectJsonLdEmails(JSON.parse(m[1]!.trim()), found);
    } catch {
      continue; // JSON hỏng ⇒ bỏ khối đó, không đoán
    }
    for (const f of found) add(f, "JSON_LD");
  }
  // 3. Cloudflare che email.
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']|\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    const e = decodeCloudflareEmail(m[1] ?? m[2] ?? "");
    if (e) add(e, "CLOUDFLARE");
  }
  // 4. Chữ thường trên trang (đã bỏ script / style / chú thích HTML).
  const text = stripToText(html);
  for (const m of text.matchAll(EMAIL_IN_TEXT)) add(m[0], "TEXT");
  // 5. Dạng viết che.
  const deob = deobfuscateEmailText(text);
  if (deob !== text) for (const m of deob.matchAll(EMAIL_IN_TEXT)) add(m[0], "OBFUSCATED");
  return out;
}

// ─────────────────────────── vai trò ───────────────────────────

const PURCHASING_SUB = /(purchas|procure|buyer|buying|thumua|thu-mua|muahang|mua-hang|nhaphang|nhap-hang)/;
const SALES_TOKENS = new Set(["sale", "sales", "order", "orders", "trade", "kd"]);
const SALES_SUB = /(kinhdoanh|kinh-doanh|b2b|wholesale|export|banhang|ban-hang|dathang|dat-hang|distribut|dealer|partner|doitac|doi-tac|dai-?ly|bansi|ban-si|giasi|gia-si)/;
/** Liên hệ chung — gồm cả hộp thư CHỦ / giám đốc / quản lý (`chu@quan.vn`): ở quán nhỏ đó chính là người quyết mua. */
const GENERAL_TOKENS = new Set(["info", "infos", "contact", "contacts", "hello", "hi", "lienhe", "admin", "office", "support", "cskh", "hotro", "mail", "enquiry", "enquiries", "inquiry", "inquiries", "hotline", "service", "services", "cs", "customerservice", "care", "team", "booking", "datban", "reservation", "reservations", "chu", "chuquan", "chunhahang", "owner", "boss", "giamdoc", "director", "ceo", "founder", "manager", "quanly"]);
const GENERAL_SUB = /(lienhe|lien-he|contact|hotro|ho-tro|cskh|support|customerservice|info)/;
const OTHER_TOKENS = new Set(["hr", "tuyendung", "jobs", "job", "career", "careers", "recruit", "recruitment", "ketoan", "accounting", "accountant", "billing", "invoice", "invoices", "hoadon", "finance", "marketing", "media", "press", "pr", "web", "webmaster", "it", "tech", "dev", "legal", "privacy", "abuse", "postmaster", "security", "newsletter", "shop", "store", "cuahang"]);
/** Họ người Việt phổ biến — một chuỗi đơn bắt đầu bằng họ (`nguyenvana`, `tranlan`) gần như chắc là tên người. */
const VN_SURNAMES = ["nguyen", "tran", "le", "pham", "hoang", "huynh", "phan", "vu", "vo", "dang", "bui", "do", "ho", "ngo", "duong", "ly", "dinh", "truong", "lam", "mai", "trinh", "cao", "luong"];

/**
 * Vai trò của một email theo phần trước @. `siteDomain` cho phép nhận ra hộp thư mang TÊN THƯƠNG HIỆU
 * (`biendong@gmail.com` của biendong.vn) là liên hệ chung, không phải tên người.
 */
export function classifyEmailRole(email: string, siteDomain?: string | null): EmailRole {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  const bare = local.replace(/\d+$/g, "");
  const tokens = bare.split(/[._+-]+/).filter(Boolean);
  if (PURCHASING_SUB.test(local)) return "PURCHASING";
  if (tokens.some((t) => SALES_TOKENS.has(t)) || SALES_SUB.test(local)) return "SALES";
  if (tokens.some((t) => GENERAL_TOKENS.has(t)) || GENERAL_SUB.test(local)) return "GENERAL";
  if (tokens.some((t) => OTHER_TOKENS.has(t))) return "OTHER";
  const brand = (siteDomain ?? "").replace(/^www\./, "").split(".")[0]?.replace(/-/g, "") ?? "";
  const flat = tokens.join("");
  if (brand.length >= 4 && flat.length >= 4 && (flat === brand || flat.includes(brand) || brand.includes(flat))) return "GENERAL";
  if (/^[a-z]{1,20}([._-][a-z]{1,20}){1,3}$/.test(bare)) return "PERSONAL";
  if (/^[a-z]{4,24}$/.test(bare) && VN_SURNAMES.some((s) => bare.startsWith(s) && bare.length > s.length + 1)) return "PERSONAL";
  return "OTHER";
}

// ─────────────────────────── chọn trang để đọc ───────────────────────────

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

/** Mẫu đường dẫn / chữ liên kết ⇒ điểm ưu tiên. Không khớp mẫu nào thì KHÔNG đọc (không bò khắp website). */
const PAGE_PRIORITY: { score: number; path: RegExp; text: RegExp }[] = [
  { score: 100, path: /(contact|lien-?he|lien-?lac)/, text: /\b(lien he|lien lac|contact)\b/ },
  { score: 80, path: /(wholesale|distribut|dealer|b2b|purchas|procure|ban-?si|gia-?si|mua-?si|dai-?ly|doi-?tac|partner)/, text: /\b(ban si|gia si|mua si|dai ly|doi tac|wholesale|distributor|dealer|b2b|partner|purchasing|procurement)\b/ },
  { score: 60, path: /(about|gioi-?thieu|ve-?chung-?toi|company|cong-?ty)/, text: /\b(gioi thieu|ve chung toi|about)\b/ },
  { score: 40, path: /(impressum|imprint)/, text: /\b(impressum|imprint)\b/ },
  { score: 20, path: /(he-?thong|chi-?nhanh|dat-?ban|booking|support|ho-?tro)/, text: /\b(he thong|chi nhanh|dat ban|ho tro)\b/ },
];
const SKIP_PATH = /(login|logout|dang-?nhap|dang-?ky|register|cart|gio-?hang|checkout|thanh-?toan|account|tai-?khoan|wp-admin|wp-login|\/search|\/tag\/|\/feed)|\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|mp4)$/i;
const FOOTER_BONUS = 10;

/** Hai host là CÙNG website (chỉ khác `www.`). */
export function sameSite(a: string, b: string): boolean {
  const n = (h: string) => h.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  return n(a) === n(b);
}

/**
 * Trang nên đọc tiếp, xếp theo ưu tiên (rồi theo thứ tự xuất hiện). Chỉ link http/https CÙNG website; bỏ trang đăng nhập /
 * giỏ hàng / tệp; liên kết nằm trong `<footer>` được cộng điểm (doanh nghiệp hay để «Liên hệ» ở chân trang).
 */
export function rankContactPages(html: string, baseUrl: string, limit: number): string[] {
  if (limit <= 0) return [];
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const footerRanges: [number, number][] = [];
  for (const m of html.matchAll(/<footer\b[\s\S]*?<\/footer>/gi)) footerRanges.push([m.index!, m.index! + m[0].length]);
  const inFooter = (i: number) => footerRanges.some(([a, b]) => i >= a && i < b);
  const best = new Map<string, { score: number; order: number }>();
  let order = 0;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1] ?? "");
    const raw = decodeHtmlEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    if (!raw || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !sameSite(u.hostname, base.hostname)) continue;
    const path = fold(decodeURIComponentSafe(u.pathname));
    if (SKIP_PATH.test(path)) continue;
    const text = fold(decodeHtmlEntities((m[2] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "));
    let score = 0;
    for (const p of PAGE_PRIORITY) if (p.path.test(path) || p.text.test(text)) score = Math.max(score, p.score);
    if (!score) continue;
    if (inFooter(m.index!)) score += FOOTER_BONUS;
    u.hash = "";
    const key = u.toString();
    if (key === base.toString()) continue;
    const prev = best.get(key);
    if (!prev) best.set(key, { score, order: order++ });
    else if (score > prev.score) prev.score = score;
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order)
    .slice(0, limit)
    .map(([k]) => k);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ─────────────────────────── ghép + chọn tốt nhất ───────────────────────────

export type DomainMx = { mx: EmailMxStatus; mxVia: "MX" | "A" | null };

const VIA_RANK: Record<EmailVia, number> = { MAILTO: 3, JSON_LD: 3, CLOUDFLARE: 3, TEXT: 2, OBFUSCATED: 1 };

/** Phát hiện (đã khử trùng theo email, giữ nguồn đầu tiên) + kết quả DNS theo tên miền ⇒ dòng kiểm đã phân loại. */
export function buildEmailChecks(candidates: readonly EmailCandidate[], mxByDomain: Readonly<Record<string, DomainMx>>, siteDomain: string | null): EmailCheck[] {
  const out: EmailCheck[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const email = normalizeEmail(c.email);
    if (!email || isJunkEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const dns = mxByDomain[emailDomainOf(email)] ?? { mx: "UNKNOWN", mxVia: null };
    out.push({ email, role: classifyEmailRole(email, siteDomain), mx: dns.mx, mxVia: dns.mxVia, sameDomain: emailMatchesSite(email, siteDomain), sourceUrl: c.sourceUrl, via: c.via });
    if (out.length >= EMAIL_MAX_PER_SITE) break;
  }
  return out;
}

/**
 * Email tốt nhất để điền vào hồ sơ lead: vai trò (mua hàng › kinh doanh › liên hệ chung › cá nhân) › cùng tên miền
 * website › tên miền nhận thư › nguồn chắc hơn › chữ cái (ổn định). `OTHER` và `NO_MX` không bao giờ được chọn: một địa
 * chỉ tên miền không nhận thư thì điền vào là bịa ra một kênh liên hệ.
 */
export function pickBestEmail(checks: readonly EmailCheck[]): EmailCheck | null {
  const eligible = checks.filter((c) => c.role !== "OTHER" && c.mx !== "NO_MX");
  if (!eligible.length) return null;
  return [...eligible].sort(
    (a, b) =>
      EMAIL_ROLE_RANK[b.role] - EMAIL_ROLE_RANK[a.role] ||
      Number(b.sameDomain) - Number(a.sameDomain) ||
      Number(b.mx === "VALID_MX") - Number(a.mx === "VALID_MX") ||
      VIA_RANK[b.via] - VIA_RANK[a.via] ||
      a.email.localeCompare(b.email),
  )[0]!;
}

/**
 * Có ghi email tốt nhất vào `wholesale_leads.email` không. Chỉ khi ô TRỐNG, hoặc giá trị đang có do CHÍNH MÁY điền ở lượt
 * trước. Ô nhân viên đã sửa (`staff_edited_fields` có `email`) thì không bao giờ.
 */
export function emailFillDecision(o: { current: string | null; staffEdited: boolean; machineFilledBefore: boolean; best: string | null }): string | null {
  if (o.staffEdited || !o.best) return null;
  const cur = (o.current ?? "").trim().toLowerCase();
  if (!cur) return o.best;
  if (o.machineFilledBefore && cur !== o.best) return o.best;
  return null;
}

// ─────────────────────────── DNS (lớp IO mỏng) ───────────────────────────

export type MxRecord = { exchange: string; priority: number };
export type EmailDns = {
  resolveMx: (domain: string) => Promise<MxRecord[]>;
  resolve4: (domain: string) => Promise<string[]>;
  resolve6: (domain: string) => Promise<string[]>;
};

/** Resolver hệ thống có trần thời gian, một lần thử. Chỉ hỏi DNS — không mở kết nối tới máy chủ thư. */
export function systemEmailDns(timeoutMs = EMAIL_DNS_TIMEOUT_MS): EmailDns {
  const r = new DnsResolver({ timeout: timeoutMs, tries: 1 });
  return { resolveMx: (d) => r.resolveMx(d), resolve4: (d) => r.resolve4(d), resolve6: (d) => r.resolve6(d) };
}

function errCode(e: unknown): string {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("DNS quá giờ"), { code: "ETIMEOUT" })), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Tên miền có nhận thư không. `ENOTFOUND` (tên miền không tồn tại) ⇒ NO_MX; `ENODATA` (không có bản ghi loại đó) ⇒ thử
 * A/AAAA; mọi lỗi khác (quá giờ, SERVFAIL, từ chối) ⇒ UNKNOWN — DNS hỏng không có nghĩa là tên miền hỏng.
 */
export async function checkEmailDomain(domain: string, dns: EmailDns, timeoutMs = EMAIL_DNS_TIMEOUT_MS * 2): Promise<DomainMx> {
  let records: MxRecord[] = [];
  try {
    records = await withTimeout(dns.resolveMx(domain), timeoutMs);
  } catch (e) {
    const c = errCode(e);
    if (c === "ENOTFOUND") return { mx: "NO_MX", mxVia: null };
    if (c !== "ENODATA") return { mx: "UNKNOWN", mxVia: null };
  }
  if (records.length) {
    // «Null MX» (RFC 7505): một bản ghi với exchange rỗng / "." = tên miền tuyên bố KHÔNG nhận thư.
    if (records.every((r) => !r.exchange || r.exchange === ".")) return { mx: "NO_MX", mxVia: null };
    return { mx: "VALID_MX", mxVia: "MX" };
  }
  let sawError = false;
  for (const fn of [dns.resolve4, dns.resolve6]) {
    try {
      const addrs = await withTimeout(fn(domain), timeoutMs);
      if (addrs.length) return { mx: "VALID_MX", mxVia: "A" };
    } catch (e) {
      const c = errCode(e);
      if (c !== "ENODATA" && c !== "ENOTFOUND") sawError = true;
    }
  }
  return { mx: sawError ? "UNKNOWN" : "NO_MX", mxVia: null };
}

/** Kiểm tối đa `maxDomains` tên miền (tên miền website trước), mỗi tên miền MỘT lần. */
export async function checkEmailDomains(emails: readonly string[], dns: EmailDns, opts: { siteDomain: string | null; maxDomains: number }): Promise<Record<string, DomainMx>> {
  const domains = [...new Set(emails.map(emailDomainOf))].sort((a, b) => Number(emailMatchesSite(`x@${b}`, opts.siteDomain)) - Number(emailMatchesSite(`x@${a}`, opts.siteDomain)));
  const out: Record<string, DomainMx> = {};
  for (const d of domains.slice(0, Math.max(0, opts.maxDomains))) out[d] = await checkEmailDomain(d, dns);
  return out;
}

// ─────────────────────────── đọc lại cho màn hình ───────────────────────────

export type EmailScan = { checks: EmailCheck[]; best: string | null; verifiedAt: string };

const VIAS: readonly EmailVia[] = ["MAILTO", "JSON_LD", "CLOUDFLARE", "TEXT", "OBFUSCATED"];

/** `meta` của một dòng nhật ký ⇒ lượt quét email (kiểm từng trường; dòng hỏng / cũ thì bỏ, không đoán). HÀM THUẦN. */
export function emailScanOf(meta: unknown): EmailScan | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  if (!Array.isArray(m.emailChecks) || typeof m.emailVerifiedAt !== "string") return null;
  const checks: EmailCheck[] = [];
  for (const raw of m.emailChecks) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.email !== "string" || typeof c.sourceUrl !== "string" || !isEmailRole(c.role) || !isEmailMxStatus(c.mx)) continue;
    checks.push({ email: c.email, role: c.role, mx: c.mx, mxVia: c.mxVia === "MX" || c.mxVia === "A" ? c.mxVia : null, sameDomain: c.sameDomain === true, sourceUrl: c.sourceUrl, via: VIAS.includes(c.via as EmailVia) ? (c.via as EmailVia) : "TEXT" });
  }
  return { checks, best: typeof m.emailBest === "string" ? m.emailBest : null, verifiedAt: m.emailVerifiedAt };
}

export type LeadEmailRow = EmailCheck & { firstSeenAt: string; verifiedAt: string | null; inLatestScan: boolean; inProfile: boolean };

/**
 * Mọi email từng tìm thấy (dòng `wholesale_lead_enrichments` kind EMAIL) ghép với lượt quét MỚI NHẤT. Email không còn ở
 * lượt mới nhất vẫn hiện (có URL nguồn để kiểm lại) nhưng MX = CHƯA BIẾT và đánh dấu «không thấy ở lượt gần nhất».
 */
export function leadEmailRows(found: readonly { value: string; sourceUrl: string; fetchedAt: Date | string }[], latest: EmailScan | null, profileEmail: string | null, siteDomain: string | null): LeadEmailRow[] {
  const byEmail = new Map((latest?.checks ?? []).map((c) => [c.email, c]));
  const profile = (profileEmail ?? "").trim().toLowerCase();
  const rows: LeadEmailRow[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const email = f.value.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const c = byEmail.get(email);
    const firstSeenAt = typeof f.fetchedAt === "string" ? f.fetchedAt : f.fetchedAt.toISOString();
    rows.push(
      c
        ? { ...c, firstSeenAt, verifiedAt: latest!.verifiedAt, inLatestScan: true, inProfile: email === profile }
        : { email, role: classifyEmailRole(email, siteDomain), mx: "UNKNOWN", mxVia: null, sameDomain: emailMatchesSite(email, siteDomain), sourceUrl: f.sourceUrl, via: "TEXT", firstSeenAt, verifiedAt: null, inLatestScan: false, inProfile: email === profile },
    );
  }
  return rows.sort((a, b) => Number(b.inProfile) - Number(a.inProfile) || Number(b.inLatestScan) - Number(a.inLatestScan) || EMAIL_ROLE_RANK[b.role] - EMAIL_ROLE_RANK[a.role] || a.email.localeCompare(b.email));
}

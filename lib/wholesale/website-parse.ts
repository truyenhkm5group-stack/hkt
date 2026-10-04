import { extractVnPhones } from "@/lib/wholesale/phone";

/**
 * ═══════════ ĐỌC TRANG CÔNG KHAI CỦA DOANH NGHIỆP — HÀM THUẦN ═══════════
 *
 * Đầu vào là HTML đã tải (lib/wholesale/website.ts lo phần mạng). Chỉ trích những gì doanh nghiệp TỰ CÔNG BỐ để khách
 * liên hệ: email doanh nghiệp, hotline, trang Facebook / Zalo, câu mô tả. Không trích thông tin cá nhân không cần thiết
 * (không đọc tên người, không đọc bình luận). Mỗi phát hiện mang URL nguồn để kiểm lại được.
 */

export type WebsiteFinding = { kind: "EMAIL" | "PHONE" | "FACEBOOK" | "ZALO" | "CONTACT_PAGE" | "DESCRIPTION"; value: string; sourceUrl: string };

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}/g;
/** Đuôi tệp ảnh / tài nguyên hay lọt vào mẫu email (`logo@2x.png`). */
const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?)$/i;
/** Hộp thư hệ thống / mẫu — không phải kênh liên hệ của doanh nghiệp. */
const JUNK_EMAIL = /^(no-?reply|noreply|example|test|user|your(name|email)?|email|name)@|@(example\.(com|org)|sentry\.io|wixpress\.com|domain\.com|email\.com)$/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d{1,6});/g, (_, d: string) => {
      const n = Number(d);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : "";
    });
}

/** Bỏ script / style / thẻ ⇒ chữ thuần để dò SĐT / email. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Mọi `href` của thẻ `<a>`, đã giải `&amp;`. */
export function extractHrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (v) out.push(v);
  }
  return out;
}

export function extractMetaDescription(html: string): string | null {
  const m = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(html) ?? /<meta\b[^>]*\bproperty\s*=\s*["']og:description["'][^>]*>/i.exec(html);
  if (!m) return null;
  const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
  const v = c ? decodeEntities((c[1] ?? c[2] ?? "").trim()).replace(/\s+/g, " ") : "";
  return v.length >= 10 ? v.slice(0, 500) : null;
}

function normalizeSocial(href: string): { kind: "FACEBOOK" | "ZALO"; url: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|web)\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  if ((host === "facebook.com" || host === "fb.com") && path.length > 1 && !/^\/(sharer|share|plugins|dialog|tr|login)/i.test(path)) {
    return { kind: "FACEBOOK", url: `https://www.facebook.com${path}` };
  }
  if ((host === "zalo.me" || host === "oa.zalo.me") && path.length > 1) return { kind: "ZALO", url: `https://zalo.me${path}` };
  return null;
}

/** Link nội bộ trông giống trang liên hệ / giới thiệu — trang kế tiếp đáng đọc. */
const CONTACT_PATH = /(lien-?he|contact|gioi-?thieu|about|ve-chung-toi|he-thong|chi-nhanh|dat-ban|booking)/i;

export function contactPageCandidates(html: string, baseUrl: string, limit = 4): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const href of extractHrefs(html)) {
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.hostname !== base.hostname || (u.protocol !== "https:" && u.protocol !== "http:")) continue;
    if (!CONTACT_PATH.test(u.pathname)) continue;
    u.hash = "";
    const s = u.toString();
    if (s !== base.toString() && !out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Một trang ⇒ các phát hiện. Không trùng trong cùng trang. */
export function extractFindings(html: string, pageUrl: string, opts: { isContactPage: boolean }): WebsiteFinding[] {
  const out: WebsiteFinding[] = [];
  const seen = new Set<string>();
  const push = (f: WebsiteFinding) => {
    const k = `${f.kind}|${f.value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(f);
  };
  const text = htmlToText(html);
  const hrefs = extractHrefs(html);

  const emails = new Set<string>();
  for (const h of hrefs) if (/^mailto:/i.test(h)) emails.add(h.replace(/^mailto:/i, "").split("?")[0]!.trim());
  for (const m of text.matchAll(EMAIL_RE)) emails.add(m[0]);
  for (const e of emails) {
    const v = e.toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(v) || ASSET_SUFFIX.test(v) || JUNK_EMAIL.test(v)) continue;
    push({ kind: "EMAIL", value: v, sourceUrl: pageUrl });
    if (out.filter((f) => f.kind === "EMAIL").length >= 5) break;
  }

  const telText = hrefs
    .filter((h) => /^tel:/i.test(h))
    .map((h) => h.replace(/^tel:/i, ""))
    .join(" \n ");
  for (const p of extractVnPhones(`${telText} \n ${text}`, 5)) if (p.normalized) push({ kind: "PHONE", value: p.normalized, sourceUrl: pageUrl });

  for (const h of hrefs) {
    const s = normalizeSocial(h);
    if (s) push({ kind: s.kind, value: s.url, sourceUrl: pageUrl });
  }

  if (opts.isContactPage) push({ kind: "CONTACT_PAGE", value: pageUrl, sourceUrl: pageUrl });
  const desc = extractMetaDescription(html);
  if (desc) push({ kind: "DESCRIPTION", value: desc, sourceUrl: pageUrl });
  return out;
}

/**
 * robots.txt tối giản: đọc nhóm `User-agent: *` (và nhóm mang tên bot của mình nếu có), trả `false` khi đường dẫn bị
 * `Disallow` mà không có `Allow` dài hơn khớp. Không đọc được tệp ⇒ được phép (chuẩn robots: thiếu tệp = không cấm).
 */
export function robotsAllows(robotsTxt: string | null, path: string, agent = "vnx-erp-lead-hunter"): boolean {
  if (!robotsTxt) return true;
  type Group = { agents: string[]; rules: { allow: boolean; path: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (cur && value) cur.rules.push({ allow: field === "allow", path: value });
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      const prefix = r.path.replace(/\*.*$/, "").replace(/\$$/, "");
      if (path.startsWith(prefix) && (!best || prefix.length > best.len || (prefix.length === best.len && r.allow))) best = { allow: r.allow, len: prefix.length };
    }
  }
  return best ? best.allow : true;
}

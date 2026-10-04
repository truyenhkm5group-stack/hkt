import { fetchPublicUrl, normalizeUserUrl, type Resolver } from "@/lib/net/public-url";
import { contactPageCandidates, extractFindings, robotsAllows, type WebsiteFinding } from "@/lib/wholesale/website-parse";

/**
 * ═══════════ ĐỌC WEBSITE CÔNG KHAI CỦA DOANH NGHIỆP ═══════════
 *
 * Địa chỉ website đến từ DỮ LIỆU BÊN NGOÀI (Google, tệp nhập tay), nên máy chủ gọi một URL người khác chọn. Rào SSRF là
 * MỘT bản dùng chung: `fetchPublicUrl` (lib/net/public-url.ts — chỉ http/https cổng mặc định, tên miền phân giải ra địa chỉ
 * công cộng, tự theo chuyển hướng ≤ 3 bước và kiểm lại mỗi bước, trần thời gian + dung lượng). Tệp này chỉ thêm luật của
 * việc ĐỌC TRANG LIÊN HỆ:
 *
 *  · Tôn trọng robots.txt (nhóm `*`); không đăng nhập, không gửi cookie, không vượt captcha / tường phí — gặp 401 / 403 /
 *    429 hay trang thử thách captcha thì dừng và ghi BLOCKED.
 *  · Chỉ đọc `text/html` (robots.txt: văn bản), cắt 512 KB / trang, tối đa `maxPages` trang CÙNG host.
 */

export type WebsiteDeps = { fetch?: typeof fetch; resolve?: Resolver };

const MAX_TEXT = 512 * 1024;

export type PageFetch = { ok: true; url: string; html: string; status: number } | { ok: false; url: string; reason: string; blocked: boolean };

/** Một trang qua rào SSRF chung, rồi kiểm thêm mã trả về / loại nội dung / captcha. */
export async function fetchPublicPage(raw: string, deps: WebsiteDeps = {}, kind: "HTML" | "TEXT" = "HTML"): Promise<PageFetch> {
  const r = await fetchPublicUrl(raw, { fetch: deps.fetch, resolve: deps.resolve, accept: kind === "HTML" ? "text/html,application/xhtml+xml" : "text/plain" });
  if (!r.ok) return { ok: false, url: raw, reason: r.error, blocked: /nội bộ|không nhận|http \/ https|cổng|tên đăng nhập/i.test(r.error) };
  if (r.status === 401 || r.status === 403 || r.status === 429) return { ok: false, url: r.url, reason: `Trang từ chối (HTTP ${r.status}) — không vượt`, blocked: true };
  if (r.status < 200 || r.status >= 300) return { ok: false, url: r.url, reason: `HTTP ${r.status}`, blocked: false };
  if (kind === "HTML" && !/text\/html|application\/xhtml/i.test(r.contentType)) return { ok: false, url: r.url, reason: `Không phải trang HTML (${r.contentType.slice(0, 40) || "không rõ"})`, blocked: false };
  if (kind === "TEXT" && r.contentType && !/^text\//i.test(r.contentType)) return { ok: false, url: r.url, reason: `Không phải văn bản (${r.contentType.slice(0, 40)})`, blocked: false };
  const html = new TextDecoder("utf-8", { fatal: false }).decode(r.body.subarray(0, MAX_TEXT));
  if (/g-recaptcha|cf-challenge|hcaptcha|challenge-platform/i.test(html) && html.length < 20_000) return { ok: false, url: r.url, reason: "Trang chắn bằng captcha — không vượt", blocked: true };
  return { ok: true, url: r.url, html, status: r.status };
}

export type EnrichResult = {
  status: "DONE" | "FAILED" | "BLOCKED";
  findings: WebsiteFinding[];
  pagesRead: number;
  note: string;
};

/**
 * Đọc trang chủ + tối đa `maxPages - 1` trang liên hệ / giới thiệu CÙNG host. robots.txt cấm ⇒ dừng ngay (BLOCKED).
 */
export async function enrichFromWebsite(website: string, opts: { maxPages: number }, deps: WebsiteDeps = {}): Promise<EnrichResult> {
  const start = normalizeUserUrl(website);
  if ("error" in start) return { status: "BLOCKED", findings: [], pagesRead: 0, note: start.error };
  const origin = `${start.protocol}//${start.host}`;
  // robots.txt: tải được thì đọc; không có / lỗi ⇒ coi như không cấm (chuẩn robots). Cùng rào SSRF với trang thường.
  const r = await fetchPublicPage(`${origin}/robots.txt`, deps, "TEXT");
  if (!r.ok && r.blocked && /nội bộ|không nhận/i.test(r.reason)) return { status: "BLOCKED", findings: [], pagesRead: 0, note: r.reason };
  const robots = r.ok ? r.html.slice(0, 64_000) : null;
  if (!robotsAllows(robots, start.pathname || "/")) return { status: "BLOCKED", findings: [], pagesRead: 0, note: "robots.txt không cho đọc trang này" };

  const home = await fetchPublicPage(start.toString(), deps);
  if (!home.ok) return { status: home.blocked ? "BLOCKED" : "FAILED", findings: [], pagesRead: 0, note: home.reason };
  const findings: WebsiteFinding[] = [...extractFindings(home.html, home.url, { isContactPage: false })];
  let pagesRead = 1;
  for (const next of contactPageCandidates(home.html, home.url, Math.max(0, opts.maxPages - 1))) {
    if (!robotsAllows(robots, new URL(next).pathname)) continue;
    const page = await fetchPublicPage(next, deps);
    if (!page.ok) continue;
    pagesRead++;
    findings.push(...extractFindings(page.html, page.url, { isContactPage: true }));
  }
  const uniq = new Map<string, WebsiteFinding>();
  for (const f of findings) if (!uniq.has(`${f.kind}|${f.value}`)) uniq.set(`${f.kind}|${f.value}`, f);
  return { status: "DONE", findings: [...uniq.values()], pagesRead, note: `Đọc ${pagesRead} trang` };
}

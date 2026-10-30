import { fetchPublicUrl, normalizeUserUrl, type Resolver } from "@/lib/net/public-url";
import type { DomainMx, EmailDns } from "@/lib/wholesale/email-discovery";
import { rankContactPages, sameSite } from "@/lib/wholesale/email-discovery";
import { extractFindings, robotsAllows, type WebsiteFinding } from "@/lib/wholesale/website-parse";

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
 *  · Chỉ đọc `text/html` (robots.txt: văn bản), cắt 512 KB / trang, tối đa `maxPages` trang CÙNG website. Trang kế tiếp
 *    chọn theo ưu tiên liên hệ › đại lý / bán sỉ / mua hàng › giới thiệu (`rankContactPages`). Trang nào bị chuyển hướng
 *    sang tên miền KHÁC thì bỏ — không theo sang website của người khác.
 */

/** `dns` chỉ dùng cho bước kiểm tên miền email (MX) ở `websiteEnrichmentProvider`; bài kiểm tiêm bản giả. */
export type WebsiteDeps = { fetch?: typeof fetch; resolve?: Resolver; dns?: EmailDns };

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
  /**
   * Kết quả kiểm DNS theo tên miền email (chỉ bộ đọc thật điền — `websiteEnrichmentProvider`). Thiếu ⇒ email lưu với
   * trạng thái `UNKNOWN` (chưa kiểm), không phải «hỏng».
   */
  emailDomains?: Record<string, DomainMx>;
};

/**
 * Đọc trang chủ + tối đa `maxPages - 1` trang liên hệ / giới thiệu CÙNG host. robots.txt cấm ⇒ dừng ngay (BLOCKED).
 */
export async function enrichFromWebsite(website: string, opts: { maxPages: number }, deps: WebsiteDeps = {}): Promise<EnrichResult> {
  const start = normalizeUserUrl(website);
  if ("error" in start) return { status: "BLOCKED", findings: [], pagesRead: 0, note: start.error };
  const origin = `${start.protocol}//${start.host}`;
  // KHÔNG theo sang tên miền khác: mọi request (kể cả bước chuyển hướng do rào SSRF tự đi) qua bộ gác này. Rào SSRF vẫn là
  // MỘT bản (`fetchPublicUrl`) — bộ gác chỉ thay hàm `fetch` nó gọi, nên request tới website khác không bao giờ rời máy.
  const gate: { crossSite: string | null } = { crossSite: null };
  const baseFetch = deps.fetch ?? fetch;
  const guarded = ((input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).hostname;
    if (!sameSite(host, start.hostname)) {
      gate.crossSite = host;
      return Promise.reject(new Error(`cross-site ${host}`));
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  const site: WebsiteDeps = { ...deps, fetch: guarded };
  // robots.txt: tải được thì đọc; không có / lỗi ⇒ coi như không cấm (chuẩn robots). Cùng rào SSRF với trang thường.
  const r = await fetchPublicPage(`${origin}/robots.txt`, site, "TEXT");
  if (!r.ok && r.blocked && /nội bộ|không nhận/i.test(r.reason)) return { status: "BLOCKED", findings: [], pagesRead: 0, note: r.reason };
  const robots = r.ok ? r.html.slice(0, 64_000) : null;
  if (!robotsAllows(robots, start.pathname || "/")) return { status: "BLOCKED", findings: [], pagesRead: 0, note: "robots.txt không cho đọc trang này" };

  const home = await fetchPublicPage(start.toString(), site);
  if (!home.ok) return { status: home.blocked ? "BLOCKED" : "FAILED", findings: [], pagesRead: 0, note: gate.crossSite ? `Website chuyển sang tên miền khác (${gate.crossSite}) — không theo` : home.reason };
  const homeHost = new URL(home.url).hostname;
  const findings: WebsiteFinding[] = [...extractFindings(home.html, home.url, { isContactPage: false })];
  let pagesRead = 1;
  for (const next of rankContactPages(home.html, home.url, Math.max(0, opts.maxPages - 1))) {
    const nu = new URL(next);
    if (!robotsAllows(robots, `${nu.pathname}${nu.search}`)) continue;
    const page = await fetchPublicPage(next, site);
    if (!page.ok || !sameSite(new URL(page.url).hostname, homeHost)) continue; // chuyển hướng sang website khác: bộ gác đã chặn
    pagesRead++;
    findings.push(...extractFindings(page.html, page.url, { isContactPage: true }));
  }
  const uniq = new Map<string, WebsiteFinding>();
  for (const f of findings) if (!uniq.has(`${f.kind}|${f.value}`)) uniq.set(`${f.kind}|${f.value}`, f);
  return { status: "DONE", findings: [...uniq.values()], pagesRead, note: `Đọc ${pagesRead} trang` };
}

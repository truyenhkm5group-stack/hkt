/**
 * ═══ ĐỌC LINK SẢN PHẨM / SHOP NGUỒN (SRC-3) — HÀM THUẦN, CLIENT-SAFE, KHÔNG BAO GIỜ MỞ LINK ═══
 *
 * Từ chữ người dán ra (nền tảng, mã sản phẩm, link CHUẨN HOÁ). Link chuẩn hoá là khoá chống trùng thứ hai (sau `(nền tảng, mã)`):
 * cùng một sản phẩm dán từ app điện thoại, từ máy tính, có / không tham số theo dõi ⇒ cùng một link.
 *
 * Chỉ nhận `http:` / `https:` — link được in ra thành `<a href>`, nên `javascript:` và mọi giao thức khác bị từ chối ở đây.
 */
import type { SourcingPlatform } from "@/lib/constants/sourcing";

export type ParsedOfferUrl = { platform: SourcingPlatform; offerId: string | null; canonicalUrl: string };

function toUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s || s.length > 2000 || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.includes(".")) return null;
  return u;
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
const isUnder = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

/** Link chung: https + tên miền chữ thường + đường dẫn, bỏ tham số, bỏ «#…», bỏ «/» cuối. */
function plainCanonical(u: URL): string {
  const path = u.pathname.replace(/\/+$/, "");
  return `https://${u.hostname.toLowerCase()}${path}`;
}

export function parseOfferUrl(raw: string): ParsedOfferUrl | null {
  const u = toUrl(raw);
  if (!u) return null;
  const h = host(u);

  if (isUnder(h, "1688.com")) {
    const id = /\/offer\/(\d{5,20})\.html$/i.exec(u.pathname)?.[1] ?? (/^\d{5,20}$/.test(u.searchParams.get("offerId") ?? "") ? u.searchParams.get("offerId") : null);
    if (id) return { platform: "1688", offerId: id, canonicalUrl: `https://detail.1688.com/offer/${id}.html` };
    return { platform: "1688", offerId: null, canonicalUrl: plainCanonical(u) };
  }
  if (isUnder(h, "alibaba.com")) {
    const id = /_(\d{6,20})\.html$/i.exec(u.pathname)?.[1] ?? null;
    if (id && /^\/product-detail\//i.test(u.pathname)) return { platform: "ALIBABA", offerId: id, canonicalUrl: `https://www.alibaba.com/product-detail/_${id}.html` };
    return { platform: "ALIBABA", offerId: null, canonicalUrl: plainCanonical(u) };
  }
  if (isUnder(h, "taobao.com") || isUnder(h, "tmall.com")) {
    const id = u.searchParams.get("id");
    if (id && /^\d{5,20}$/.test(id)) {
      const base = isUnder(h, "tmall.com") ? "https://detail.tmall.com/item.htm" : "https://item.taobao.com/item.htm";
      return { platform: "TAOBAO", offerId: id, canonicalUrl: `${base}?id=${id}` };
    }
    return { platform: "TAOBAO", offerId: null, canonicalUrl: plainCanonical(u) };
  }
  return { platform: "OTHER", offerId: null, canonicalUrl: plainCanonical(u) };
}

/** Link shop nhà cung cấp ⇒ dạng chuẩn (khoá UNIQUE của `sourcing_suppliers`). Shop 1688 dạng `<tên>.1688.com` giữ tên miền con. */
export function canonicalShopUrl(raw: string): string | null {
  const u = toUrl(raw);
  return u ? plainCanonical(u) : null;
}

/**
 * Link ảnh ⇒ khoá «có thể trùng ảnh» (chỉ GẮN CỜ, không gộp). Bỏ tham số và hậu tố cỡ ảnh của CDN Alibaba
 * (`…jpg_220x220.jpg` ⇒ `…jpg`) để cùng một ảnh ở hai cỡ ra cùng khoá. `null` khi không phải link http(s).
 */
export function imageKey(raw: string): string | null {
  const u = toUrl(raw);
  if (!u) return null;
  const path = u.pathname.replace(/(\.(?:jpe?g|png|webp|gif))_\d+x\d+[a-z0-9]*\.(?:jpe?g|png|webp)$/i, "$1");
  return `${u.hostname.toLowerCase()}${path}`.toLowerCase();
}

/** Link an toàn để in thành `<a href>` / `<img src>` — chỉ http(s); khác ⇒ `null`. */
export function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  const u = toUrl(raw);
  return u ? u.toString() : null;
}

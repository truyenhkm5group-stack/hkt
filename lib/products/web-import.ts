import type { SessionUser } from "@/lib/auth/session";
import { fetchPublicUrl, normalizeUserUrl, type Resolver } from "@/lib/net/public-url";
import { PRODUCT_IMPORT_MAX_ROWS, PRODUCT_NAME_MAX, PRODUCT_IMPORT_MONEY_MAX } from "@/lib/products/import-shared";
import { productCreateGate } from "@/lib/records/product-create";

/**
 * ═══════════ NHẬP SẢN PHẨM TỪ LINK WEBSITE CỦA SHOP (docs/platform/quick-start.md §10) ═══════════
 *
 * Shop có website (Shopify / Haravan / WooCommerce / trang có dữ liệu sản phẩm chuẩn) dán link ⇒ máy chủ đọc danh sách sản
 * phẩm và dựng một tệp CSV ĐÚNG khuôn tệp mẫu, rồi đưa vào CHÍNH trình nhập tệp đang có (xem trước → ghép cột → kiểm → nhập).
 * Không có đường ghi thứ hai: kiểm trùng SKU, luật giá, quyền, nhật ký… đều là của trình nhập tệp.
 *
 * Ba nguồn, thử theo thứ tự, KHÔNG gọi AI (không tốn tiền, không đoán):
 *  1. `/products.json` — chuẩn Shopify (Haravan và nhiều nền tảng học theo): mỗi biến thể một dòng, giá trong dữ liệu.
 *  2. WooCommerce Store API `/wp-json/wc/store/v1/products` — giá theo đơn vị nhỏ nhất (`currency_minor_unit`).
 *  3. JSON-LD `schema.org/Product` trong chính trang được dán (trang sản phẩm / danh sách) — chuẩn SEO, Google đọc.
 * Không nguồn nào có ⇒ nói thẳng, gợi ý dùng tệp mẫu. Giá không đọc rõ ⇒ ô trống (CHƯA KHAI), không phải 0 đ.
 */

export type WebProductRow = { name: string; sku: string; price: number | null; category: string };
export type WebImportSource = "SHOPIFY" | "WOOCOMMERCE" | "JSONLD";
export const WEB_IMPORT_SOURCE_LABEL: Record<WebImportSource, string> = {
  SHOPIFY: "danh sách sản phẩm /products.json (Shopify / Haravan)",
  WOOCOMMERCE: "WooCommerce Store API",
  JSONLD: "dữ liệu sản phẩm chuẩn (JSON-LD) trong trang",
};

const SHOPIFY_PAGE = 250;
const SHOPIFY_MAX_PAGES = 8;
const WOO_PAGE = 100;
const WOO_MAX_PAGES = 20;

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** Giá dạng số / chuỗi số thập phân của API ⇒ VND nguyên. Không rõ / âm / quá trần ⇒ `null`. HÀM THUẦN. */
export function moneyFrom(v: unknown, divisor = 1): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) / divisor);
  return Number.isFinite(n) && n > 0 && n <= PRODUCT_IMPORT_MONEY_MAX ? n : null;
}

function row(name: string, sku: unknown, price: number | null, category: unknown): WebProductRow | null {
  const n = name.slice(0, PRODUCT_NAME_MAX);
  return n ? { name: n, sku: str(sku).slice(0, 60), price, category: str(category).slice(0, 100) } : null;
}

/** `/products.json` (Shopify-chuẩn) ⇒ dòng. Biến thể «Default Title» ⇒ tên sản phẩm trơn. HÀM THUẦN. */
export function fromShopifyProducts(json: unknown): WebProductRow[] {
  const list = (json as { products?: unknown })?.products;
  if (!Array.isArray(list)) return [];
  const out: WebProductRow[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const title = str(o.title);
    const variants = Array.isArray(o.variants) ? (o.variants as Record<string, unknown>[]) : [];
    if (!variants.length) {
      const r = row(title, "", null, o.product_type);
      if (r) out.push(r);
      continue;
    }
    for (const v of variants) {
      const vt = str(v?.title);
      const name = vt && !/^default( title)?$/i.test(vt) && variants.length > 1 ? `${title} - ${vt}` : title;
      const r = row(name, v?.sku, moneyFrom(v?.price), o.product_type);
      if (r) out.push(r);
    }
  }
  return out;
}

/** WooCommerce Store API ⇒ dòng. Giá là số NGUYÊN theo đơn vị nhỏ nhất: chia 10^currency_minor_unit. HÀM THUẦN. */
export function fromWooProducts(json: unknown): WebProductRow[] {
  if (!Array.isArray(json)) return [];
  const out: WebProductRow[] = [];
  for (const p of json) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const prices = (o.prices ?? {}) as Record<string, unknown>;
    const minor = Number(prices.currency_minor_unit ?? 0);
    const divisor = Number.isInteger(minor) && minor >= 0 && minor <= 4 ? 10 ** minor : 1;
    const cats = Array.isArray(o.categories) ? (o.categories as { name?: unknown }[]) : [];
    const r = row(decodeEntities(str(o.name)), o.sku, moneyFrom(prices.price, divisor), decodeEntities(str(cats[0]?.name)));
    if (r) out.push(r);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));
}

function jsonLdProducts(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) jsonLdProducts(n, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  const type = o["@type"];
  const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
  if (types.includes("Product")) out.push(o);
  for (const k of ["@graph", "itemListElement", "item", "mainEntity", "hasVariant"]) if (k in o) jsonLdProducts(o[k], out, depth + 1);
}

/** JSON-LD `Product` trong HTML ⇒ dòng (giá: `offers.price` → `offers[0].price` → `lowPrice`). HÀM THUẦN. */
export function fromJsonLd(html: string): WebProductRow[] {
  const found: Record<string, unknown>[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      jsonLdProducts(JSON.parse(m[1].trim()), found);
    } catch {
      // Khối JSON-LD hỏng ⇒ bỏ khối đó, đọc tiếp khối khác.
    }
  }
  const out: WebProductRow[] = [];
  for (const p of found) {
    const offers = Array.isArray(p.offers) ? (p.offers[0] as Record<string, unknown> | undefined) : (p.offers as Record<string, unknown> | undefined);
    const price = moneyFrom(offers?.price) ?? moneyFrom(offers?.lowPrice);
    const cat = typeof p.category === "string" ? p.category : "";
    const r = row(decodeEntities(str(p.name)), p.sku, price, cat);
    if (r && !out.some((x) => x.name === r.name && x.sku === r.sku)) out.push(r);
  }
  return out;
}

/** Dòng ⇒ CSV ĐÚNG tiêu đề tệp mẫu (trình nhập tự ghép cột). Có BOM để Excel mở đúng tiếng Việt. HÀM THUẦN. */
export function webRowsToCsv(rows: readonly WebProductRow[]): string {
  const esc = (c: string) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  const lines = [["Tên sản phẩm", "SKU", "Giá bán", "Danh mục"], ...rows.map((r) => [r.name, r.sku, r.price === null ? "" : String(r.price), r.category])];
  return `\uFEFF${lines.map((l) => l.map(esc).join(",")).join("\r\n")}\r\n`;
}

type Deps = { fetch?: typeof fetch; resolve?: Resolver };

async function getJson(url: URL, deps: Deps): Promise<unknown> {
  const r = await fetchPublicUrl(url, { ...deps, accept: "application/json" });
  if (!r.ok || r.status !== 200) return null;
  try {
    return JSON.parse(new TextDecoder().decode(r.body));
  } catch {
    return null;
  }
}

export type WebImportResult = { ok: true; source: WebImportSource; count: number; truncated: boolean; fileName: string; base64: string; message: string } | { error: string };

/** Đọc sản phẩm từ website (không ghi gì). Cổng: CÙNG cổng tạo sản phẩm của trình nhập tệp. */
export async function productsFromWebsite(user: SessionUser, rawUrl: string, deps: Deps = {}): Promise<WebImportResult> {
  const gate = await productCreateGate(user);
  if (!gate.allowed) return { error: gate.reason };
  return readWebsiteProducts(rawUrl, deps);
}

/** Phần đọc (không cổng — chỉ `productsFromWebsite` và bài kiểm gọi). */
export async function readWebsiteProducts(rawUrl: string, deps: Deps = {}): Promise<WebImportResult> {
  const url = normalizeUserUrl(rawUrl);
  if ("error" in url) return { error: url.error };
  const origin = url.origin;
  let source: WebImportSource | null = null;
  let rows: WebProductRow[] = [];
  let truncated = false;

  // 1. /products.json (Shopify-chuẩn), có phân trang.
  for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
    const got = fromShopifyProducts(await getJson(new URL(`/products.json?limit=${SHOPIFY_PAGE}&page=${page}`, origin), deps));
    if (!got.length) break;
    source = "SHOPIFY";
    rows.push(...got);
    if (rows.length >= PRODUCT_IMPORT_MAX_ROWS || got.length < SHOPIFY_PAGE / 2) break;
  }
  // 2. WooCommerce Store API.
  if (!source) {
    for (let page = 1; page <= WOO_MAX_PAGES; page++) {
      const got = fromWooProducts(await getJson(new URL(`/wp-json/wc/store/v1/products?per_page=${WOO_PAGE}&page=${page}`, origin), deps));
      if (!got.length) break;
      source = "WOOCOMMERCE";
      rows.push(...got);
      if (rows.length >= PRODUCT_IMPORT_MAX_ROWS || got.length < WOO_PAGE) break;
    }
  }
  // 3. JSON-LD trong chính trang được dán.
  if (!source) {
    const page = await fetchPublicUrl(url, deps);
    if (!page.ok) return { error: page.error };
    if (page.status >= 400) return { error: `Website trả lỗi HTTP ${page.status}.` };
    rows = fromJsonLd(new TextDecoder().decode(page.body));
    if (rows.length) source = "JSONLD";
  }
  if (!source || !rows.length) {
    return { error: "Không đọc được danh sách sản phẩm từ website này (không có /products.json, WooCommerce hay dữ liệu sản phẩm chuẩn trong trang). Dán link một trang sản phẩm cụ thể, hoặc tải tệp mẫu và nhập bằng Excel." };
  }
  if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
    rows = rows.slice(0, PRODUCT_IMPORT_MAX_ROWS);
    truncated = true;
  }
  const csv = webRowsToCsv(rows);
  const noPrice = rows.filter((r) => r.price === null).length;
  return {
    ok: true,
    source,
    count: rows.length,
    truncated,
    fileName: `san-pham-tu-${url.hostname}.csv`,
    base64: Buffer.from(csv, "utf8").toString("base64"),
    message: `Đọc được ${rows.length.toLocaleString("vi-VN")} sản phẩm từ ${WEB_IMPORT_SOURCE_LABEL[source]}${truncated ? ` (giữ ${PRODUCT_IMPORT_MAX_ROWS} dòng đầu)` : ""}${noPrice ? ` · ${noPrice} dòng chưa đọc được giá — để trống, sửa sau` : ""}. Kiểm tra rồi bấm Nhập như tệp thường.`,
  };
}

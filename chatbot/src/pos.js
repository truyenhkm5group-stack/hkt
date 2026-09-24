import { sleep } from "./util.js";
import { log } from "./logger.js";

const BASE = "https://pos.pages.fm/api/v1";

/**
 * Client Pancake POS Open API (https://pos.pages.fm)
 * - Xac thuc bang query `api_key` (POS -> Cai dat -> API)
 */
export class PosClient {
  constructor(shopId, apiKey) {
    if (!shopId || !apiKey) throw new Error("PosClient can shopId va apiKey");
    this.shopId = String(shopId);
    this.apiKey = apiKey;
  }

  async _get(pathname, query = {}) {
    const u = new URL(`${BASE}${pathname}`);
    u.searchParams.set("api_key", this.apiKey);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      const data = await res.json().catch(() => ({}));
      if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok || data.success === false) {
        throw new Error(`POS API ${pathname} loi ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
      }
      return data;
    }
  }

  listShops() {
    return this._get("/shops");
  }

  /** Ten that cua cac page trong shop: { page_id: name } */
  async getPageNames() {
    const data = await this.listShops();
    const out = {};
    for (const shop of data.shops || []) {
      for (const pg of shop.pages || []) if (pg?.id && pg?.name) out[String(pg.id)] = String(pg.name).replace(/\s+/g, " ").trim();
    }
    return out;
  }

  /** Lay TOAN BO san pham (tu dong lat trang) */
  async getAllProducts() {
    const out = [];
    let page = 1;
    for (;;) {
      const data = await this._get(`/shops/${this.shopId}/products`, { page_size: 100, page_number: page });
      out.push(...(data.data || []));
      const totalPages = Number(data.total_pages || 1);
      if (page >= totalPages || (data.data || []).length === 0) break;
      page++;
      await sleep(300);
    }
    return out;
  }
}

/**
 * Chuan hoa san pham POS thanh dang gon cho bot:
 * { id, code, name, note, attributes: {Màu:[..], Size:[..]}, price: {min,max}, variations: [{sku, fields:{Màu,Size}, price, stock, available, images}] }
 */
export function normalizeProducts(raw, { stockMode = "order" } = {}) {
  const products = [];
  for (const p of raw || []) {
    if (p.is_removed) continue;
    const variations = [];
    for (const v of p.variations || []) {
      if (v.is_removed || v.is_hidden) continue;
      const fields = {};
      for (const f of v.fields || []) if (f?.name) fields[f.name] = f.value;
      const stock = Number(v.remain_quantity ?? 0);
      const sellNegative = v.is_sell_negative_variation ?? p.is_sell_negative ?? false;
      const available = stockMode === "strict" ? stock > 0 : stock > 0 || sellNegative;
      const price = Number(v.retail_price_after_discount ?? v.retail_price ?? 0) || Number(v.retail_price ?? 0);
      variations.push({
        id: v.id,
        sku: String(v.display_id || "").trim(),
        fields,
        price,
        listPrice: Number(v.retail_price ?? 0),
        stock,
        available,
        images: (v.images || []).filter((u) => typeof u === "string" && u.startsWith("http")),
      });
    }
    if (variations.length === 0) continue;
    const attributes = {};
    for (const a of p.product_attributes || []) if (a?.name) attributes[a.name] = a.values || [];
    const prices = variations.map((v) => v.price).filter((n) => n > 0);
    products.push({
      id: p.id,
      code: String(p.custom_id || p.display_id || "").trim(),
      name: String(p.name || "").trim(),
      note: [p.note, p.note_product].filter((s) => s && String(s).trim()).join(". "),
      attributes,
      price: { min: prices.length ? Math.min(...prices) : 0, max: prices.length ? Math.max(...prices) : 0 },
      images: [...new Set([p.image, ...variations.flatMap((v) => v.images)].filter(Boolean))],
      variations,
    });
  }
  log.debug(`POS: chuan hoa ${products.length} san pham`);
  return products;
}

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { PosClient, normalizeProducts } from "./pos.js";

const fmtVnd = (n) => (n ? Math.round(n).toLocaleString("vi-VN") + "đ" : "liên hệ");

/**
 * Danh muc san pham dong bo tu Pancake POS.
 * - refresh() moi POS_SYNC_MINUTES phut, luu cache data/catalog.json de khoi dong nhanh
 * - toPromptText(): text dua vao system prompt cho Gemini
 * - findImages(ref): tim anh theo ma san pham / SKU de gui cho khach
 */
export class Catalog {
  constructor() {
    this.enabled = !!(config.pos.shopId && config.pos.apiKey);
    this.client = this.enabled ? new PosClient(config.pos.shopId, config.pos.apiKey) : null;
    this.products = [];
    this.updatedAt = 0;
    this.file = path.join(config.dataDir, config.pos.cacheFile);
    this._timer = null;
    this._loadCache();
  }

  _loadCache() {
    try {
      if (fs.existsSync(this.file)) {
        const c = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.products = c.products || [];
        this.updatedAt = c.updatedAt || 0;
      }
    } catch (e) {
      log.warn("Khong doc duoc catalog cache:", e.message);
    }
  }

  setProducts(products) {
    this.products = products;
    this.updatedAt = Date.now();
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ updatedAt: this.updatedAt, products }));
    } catch (e) {
      log.warn("Khong ghi duoc catalog cache:", e.message);
    }
  }

  async refresh() {
    if (!this.enabled) return this.products;
    const raw = await this.client.getAllProducts();
    const products = normalizeProducts(raw, { stockMode: config.pos.stockMode });
    this.setProducts(products);
    log.info(`POS: dong bo ${products.length} san pham, ${products.reduce((n, p) => n + p.variations.length, 0)} bien the`);
    return products;
  }

  /** Dong bo ngay + lap lai dinh ky. Loi thi giu ban cu. */
  start() {
    if (!this.enabled) {
      log.warn("POS chua cau hinh (POS_SHOP_ID/POS_API_KEY) -> bot chi dung san pham ghi trong prompts/system.md");
      return;
    }
    const run = () => this.refresh().catch((e) => log.error("POS dong bo loi:", e.message));
    run();
    this._timer = setInterval(run, Math.max(1, config.pos.syncMinutes) * 60 * 1000);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
  }

  /** Text danh muc cho system prompt */
  toPromptText() {
    if (this.products.length === 0) return "(Chưa có dữ liệu sản phẩm từ POS)";
    const lines = [];
    for (const p of this.products) {
      const price = p.price.min === p.price.max ? fmtVnd(p.price.min) : `${fmtVnd(p.price.min)} – ${fmtVnd(p.price.max)}`;
      lines.push(`### ${p.name} (mã ${p.code || "?"}) – ${price}`);
      if (p.note) lines.push(`- Mô tả: ${p.note}`);
      for (const [attr, values] of Object.entries(p.attributes)) {
        if (values?.length) lines.push(`- ${attr}: ${values.join(", ")}`);
      }
      const avail = p.variations.filter((v) => v.available);
      const out = p.variations.filter((v) => !v.available);
      const label = (v) => Object.values(v.fields).join("/") || v.sku;
      if (out.length === 0) {
        lines.push(`- Tình trạng: tất cả màu/size đều đặt được`);
      } else {
        lines.push(`- Còn hàng: ${avail.map(label).join(", ") || "không"}`);
        lines.push(`- Hết hàng: ${out.map(label).join(", ")}`);
      }
      // Gia khac nhau giua bien the
      const priceSet = new Set(p.variations.map((v) => v.price));
      if (priceSet.size > 1) {
        lines.push(`- Giá từng loại: ${p.variations.map((v) => `${label(v)} ${fmtVnd(v.price)}`).join("; ")}`);
      }
      if (p.images.length) {
        const colorKey = Object.keys(p.attributes).find((k) => /m[àa]u|color/i.test(k));
        const colors = colorKey ? [...new Set(p.variations.filter((v) => v.images.length).map((v) => v.fields[colorKey]).filter(Boolean))] : [];
        if (colors.length > 1) {
          lines.push(`- Ảnh: tất cả màu [[IMG:${p.code}]]; theo màu: ${colors.map((c) => `[[IMG:${p.code}:${c}]]`).join(", ")}`);
        } else {
          lines.push(`- Ảnh: có (gửi bằng [[IMG:${p.code || p.variations[0].sku}]])`);
        }
      }
    }
    return lines.join("\n");
  }

  /**
   * Tim anh theo: SKU | ma san pham | "ma:mau" (vd Q004:Đỏ) | "ma mau" (vd Q004 nâu)
   * Khong phan biet hoa/thuong, dau, khoang trang.
   */
  findImages(ref, max = 4) {
    const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[\s_-]+/g, "");
    const raw = String(ref || "").trim();
    // "ma:mau"
    const colon = raw.split(":");
    if (colon.length >= 2) {
      const imgs = this._imagesByColor(colon[0], colon.slice(1).join(":"), norm, max);
      if (imgs.length) return imgs;
    }
    // "ma mau" (ma la token dau, phan con lai la mau)
    const sp = raw.split(/\s+/);
    if (sp.length >= 2) {
      const imgs = this._imagesByColor(sp[0], sp.slice(1).join(" "), norm, max);
      if (imgs.length) return imgs;
    }
    const key = norm(raw);
    if (!key) return [];
    for (const p of this.products) {
      for (const v of p.variations) if (norm(v.sku) === key && v.images.length) return v.images.slice(0, max);
    }
    for (const p of this.products) {
      if (norm(p.code) === key || norm(p.name) === key) {
        // 1 anh cho moi mau (bien the dau tien cua tung mau) de khach thay du mau
        const seen = new Set();
        const imgs = [];
        for (const v of p.variations) {
          const color = v.fields["Màu"] || v.fields["Color"] || v.fields["Mau"] || "";
          if (v.images.length && !seen.has(color)) {
            seen.add(color);
            imgs.push(v.images[0]);
          }
        }
        return (imgs.length ? imgs : p.images).slice(0, max);
      }
    }
    // Khop mot phan (vd "Q004" trong "Q004DOM")
    for (const p of this.products) {
      for (const v of p.variations) if (norm(v.sku).startsWith(key) && v.images.length) return v.images.slice(0, max);
    }
    return [];
  }

  _imagesByColor(codeRef, colorRef, norm, max) {
    const code = norm(codeRef), color = norm(colorRef);
    if (!code || !color) return [];
    const p = this.products.find((x) => norm(x.code) === code || norm(x.name) === code);
    if (!p) return [];
    const out = [];
    for (const v of p.variations) {
      const vColor = norm(v.fields["Màu"] || v.fields["Color"] || v.fields["Mau"] || Object.values(v.fields).find((f) => norm(f) === color) || "");
      if (vColor && (vColor === color || vColor.includes(color) || color.includes(vColor)) && v.images.length) {
        for (const u of v.images) if (!out.includes(u)) out.push(u);
      }
    }
    return out.slice(0, max);
  }

  /**
   * Anh tham chieu de AI so sanh voi anh khach gui: 1 anh cho moi mau cua moi san pham.
   * @returns {{code:string,name:string,color:string,url:string,label:string}[]}
   */
  referenceImages(max = 12) {
    const out = [];
    for (const p of this.products) {
      const seen = new Set();
      for (const v of p.variations) {
        const color = v.fields["Màu"] || v.fields["Color"] || v.fields["Mau"] || "";
        if (!v.images.length || seen.has(color)) continue;
        seen.add(color);
        out.push({ code: p.code, name: p.name, color, url: v.images[0], label: `${p.name} (mã ${p.code})${color ? " màu " + color : ""}` });
        if (out.length >= max) return out;
      }
      if (!p.variations.some((v) => v.images.length) && p.images[0]) {
        out.push({ code: p.code, name: p.name, color: "", url: p.images[0], label: `${p.name} (mã ${p.code})` });
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  /** Tom tat de log / test */
  summary() {
    return this.products.map((p) => `${p.code} ${p.name} (${p.variations.length} bien the, ${fmtVnd(p.price.min)})`).join("\n");
  }
}

export const catalog = new Catalog();

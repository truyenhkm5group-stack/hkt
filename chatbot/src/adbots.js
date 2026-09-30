import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { normalizeAdBotPayload, pickAdBot } from "./adpersona.js";

/**
 * Kho "bot rieng theo quang cao" tren dia (data/ad-bots.json) + so quan sat ad_id bot da gap.
 *
 * ERP la nguon DUY NHAT cua danh sach: moi lan day la THAY CA BO (ERP biet camp nao da tat / doi mau).
 * So quan sat (data/ad-seen.json) tra loi "khach den tu quang cao nao ma chua co bot rieng" — ad_id la
 * khong duoc bien mat im lang, ERP doc lai qua GET /api/erp/ad-bots de hien ra man hinh.
 * Hoi thoai da tung gan voi mot quang cao thi NHO lai (Pancake co the khong gui lai ad_id o moi goi tin).
 */

const MAX_SEEN = 500;
const MAX_CONV = 5000;

class AdBots {
  constructor() {
    this.file = path.join(config.dataDir, "ad-bots.json");
    this.seenFile = path.join(config.dataDir, "ad-seen.json");
    this.convFile = path.join(config.dataDir, "ad-conv.json");
    this.bots = {};
    this.syncedAt = null;
    this.seen = {};
    this.convAds = new Map();
    this._seenDirty = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.bots = j.bots && typeof j.bots === "object" ? j.bots : {};
        this.syncedAt = j.syncedAt || null;
      }
    } catch (e) {
      log.warn("Khong doc duoc ad-bots.json:", e.message);
    }
    try {
      if (fs.existsSync(this.seenFile)) this.seen = JSON.parse(fs.readFileSync(this.seenFile, "utf8")) || {};
    } catch {
      this.seen = {};
    }
    // Hoi thoai -> quang cao: luu ra dia de khoi dong lai bot (deploy) khong lam khach dang chat do mat camp
    try {
      if (fs.existsSync(this.convFile)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.convFile, "utf8")) || {})) if (Array.isArray(v)) this.convAds.set(k, v);
    } catch {}
  }

  _write(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  /** ERP day ca bo. Hinh dang sai -> nem loi, KHONG ghi gi (giu bo cu). */
  replaceAll(payload) {
    const { bots, skipped } = normalizeAdBotPayload(payload);
    this.bots = bots;
    this.syncedAt = new Date().toISOString();
    this._write(this.file, { syncedAt: this.syncedAt, bots });
    const n = Object.keys(bots).length;
    log.info(`Bot theo quang cao: nhan ${n} bot tu ERP${skipped ? ` (bo ${skipped} dong khong hop le)` : ""}`);
    return { count: n, skipped, syncedAt: this.syncedAt, missingImages: this.missingImages() };
  }

  /** Nho ad_id cua hoi thoai, tra ve danh sach day du (cu -> moi). */
  rememberConversation(conversationId, adIds) {
    const key = String(conversationId || "");
    const cur = this.convAds.get(key) || [];
    const merged = [...cur.filter((x) => !(adIds || []).includes(x)), ...(adIds || [])];
    if (key && merged.length) {
      this.convAds.delete(key);
      this.convAds.set(key, merged.slice(-5));
      if (this.convAds.size > MAX_CONV) this.convAds.delete(this.convAds.keys().next().value);
      this._scheduleSeenSave();
    }
    return merged;
  }

  /** Chon bot cho hoi thoai + ghi so quan sat. */
  resolve(pageId, conversationId, adIds) {
    const all = this.rememberConversation(conversationId, adIds);
    if (!all.length) return null;
    const bot = pickAdBot(all, this.bots);
    const adId = all[all.length - 1];
    const s = this.seen[adId] || { count: 0, firstAt: new Date().toISOString() };
    s.count += 1;
    s.lastAt = new Date().toISOString();
    s.pageId = String(pageId || "");
    s.matched = bot ? bot.adId : null;
    this.seen[adId] = s;
    const keys = Object.keys(this.seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => String(this.seen[a].lastAt).localeCompare(String(this.seen[b].lastAt)));
      for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete this.seen[k];
    }
    this._scheduleSeenSave();
    return bot;
  }

  _scheduleSeenSave() {
    if (this._seenDirty) return;
    this._seenDirty = true;
    const t = setTimeout(() => {
      this._seenDirty = false;
      try {
        this._write(this.seenFile, this.seen);
        this._write(this.convFile, Object.fromEntries(this.convAds));
      } catch (e) {
        log.warn("Khong ghi duoc ad-seen.json:", e.message);
      }
    }, 30_000);
    t.unref?.();
  }

  // ---- Anh mau test (ERP gui bang byte, khoa = sha256 cua noi dung: gui lai cung anh khong ghi lan hai) ----
  imageDir() {
    return path.join(config.dataDir, "ad-images");
  }

  imagePath(sha) {
    if (!/^[a-f0-9]{64}$/.test(String(sha || ""))) return null;
    const dir = this.imageDir();
    for (const ext of ["jpg", "png", "webp"]) {
      const f = path.join(dir, `${sha}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  /** sha anh ma cac bot dang dung nhung bot chua co tep. */
  missingImages() {
    const need = new Set();
    for (const b of Object.values(this.bots)) for (const c of b.test?.colors || []) need.add(c.sha);
    return [...need].filter((sha) => !this.imagePath(sha));
  }

  /** Luu mot anh; noi dung phai dung sha256 da khai (khong nhan anh "gan dung"). */
  saveImage({ sha, contentType, data }) {
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[String(contentType || "")];
    if (!ext) throw new Error("Chi nhan anh JPEG / PNG / WEBP");
    const buf = Buffer.from(String(data || ""), "base64");
    if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error("Anh rong hoac qua 8MB");
    const real = crypto.createHash("sha256").update(buf).digest("hex");
    if (real !== String(sha || "").toLowerCase()) throw new Error("sha256 khong khop noi dung anh");
    fs.mkdirSync(this.imageDir(), { recursive: true });
    this._writeBuf(path.join(this.imageDir(), `${real}.${ext}`), buf);
    return real;
  }

  _writeBuf(file, buf) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }

  /** Doc anh theo tham chieu "adimg:<sha>" -> { mimeType, data(base64) } | null. */
  readImageRef(ref) {
    const sha = String(ref || "").replace(/^adimg:/, "");
    const f = this.imagePath(sha);
    if (!f) return null;
    const mimeType = f.endsWith(".png") ? "image/png" : f.endsWith(".webp") ? "image/webp" : "image/jpeg";
    return { mimeType, data: fs.readFileSync(f).toString("base64") };
  }

  get(adId) {
    return this.bots[String(adId || "")] || null;
  }

  status() {
    const bots = Object.values(this.bots).map((b) => ({ adId: b.adId, productCode: b.productCode, campaignName: b.campaignName, adName: b.adName, enabled: b.enabled !== false, test: !!b.test }));
    return { syncedAt: this.syncedAt, count: bots.length, bots, seen: this.seen, missingImages: this.missingImages() };
  }
}

export const adBots = new AdBots();
